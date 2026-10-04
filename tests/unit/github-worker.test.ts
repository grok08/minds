import { describe, expect, test } from "bun:test";
import { GitHubWorkerProvider } from "../../packages/providers/github-worker/provider.ts";
import { Execution, Task } from "../../packages/runtime/src/domain/types.ts";

const eventPayload = {
  runId: 12345,
  workflow: "CI",
  branch: "main",
};

function makeTask(): Task {
  const now = new Date();
  return {
    id: "task-phase3",
    mindId: "repository",
    type: "github.ci.failed",
    description: `github.ci.failed: ${JSON.stringify(eventPayload)}`,
    status: "running",
    eventId: "event-phase3",
    createdAt: now,
    updatedAt: now,
  };
}

function makeExecution(): Execution {
  return {
    id: "execution-phase3",
    taskId: "task-phase3",
    provider: "github-worker",
    status: "running",
    startedAt: new Date(),
  };
}

function makeProvider(dispatchWorkflow: (workflowFile: string, payload: {
  ref: string;
  inputs: Record<string, string>;
}) => Promise<void>): GitHubWorkerProvider {
  return new GitHubWorkerProvider({
    github: { token: "test-token", owner: "test-owner", repo: "test-repo" },
    mindsServerUrl: "https://minds.example.test",
    mindsCallbackSecret: "test-callback-secret",
  }, {
    dispatchWorkflow,
    getWorkflowRun: async () => ({ status: "in_progress", conclusion: null }),
    cancelWorkflowRun: async () => {},
  });
}

describe("GitHubWorkerProvider", () => {
  test("dispatches the task payload and execution identity to GitHub Actions", async () => {
    const dispatches: Array<[string, { ref: string; inputs: Record<string, string> }]> = [];
    const provider = makeProvider(async (workflowFile, payload) => {
      dispatches.push([workflowFile, payload]);
    });

    const execution = await provider.start(makeTask(), makeExecution());

    expect(dispatches).toEqual([[
      "minds-worker.yml",
      {
        ref: "main",
        inputs: {
          task_id: "task-phase3",
          execution_id: "execution-phase3",
          event_type: "github.ci.failed",
          payload: JSON.stringify(eventPayload),
          minds_server_url: "https://minds.example.test",
          minds_callback_secret: "test-callback-secret",
        },
      },
    ]]);
    expect(execution.status).toBe("running");
    expect(execution.workflowRunId).toBeUndefined();
  });

  test("propagates workflow dispatch failures", async () => {
    const provider = makeProvider(async () => {
      throw new Error("GitHub dispatch failed");
    });

    await expect(provider.start(makeTask(), makeExecution())).rejects.toThrow("GitHub dispatch failed");
  });
});