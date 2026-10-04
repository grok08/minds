import { describe, expect, test } from "bun:test";
import { Octokit } from "@octokit/rest";
import { GitHubWorkerProvider } from "../../packages/providers/github-worker/provider.ts";
import {
  executeAndReport,
  executeWorkerTask,
  type WorkerOutcome,
} from "../../packages/providers/github-worker/worker.ts";
import type { Execution, Task } from "../../packages/runtime/src/domain/types.ts";
import type { MemoryContextEntry } from "../../packages/memory/src/types.ts";

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
    mindsCallbackSecret: "test-secret",
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

    const execution = await provider.start(makeTask(), makeExecution(), []);

    expect(dispatches).toEqual([[
      "minds-worker.yml",
      {
        ref: "main",
        inputs: {
          task_id: "task-phase3",
          execution_id: "execution-phase3",
          event_type: "github.ci.failed",
          payload: JSON.stringify(eventPayload),
          memory_context: "[]",
          minds_server_url: "https://minds.example.test",
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

    await expect(provider.start(makeTask(), makeExecution(), [])).rejects.toThrow("GitHub dispatch failed");
  });

  test("dispatches persisted approval context for continuation executions", async () => {
    const dispatches: Array<{ ref: string; inputs: Record<string, string> }> = [];
    const provider = makeProvider(async (_workflowFile, payload) => {
      dispatches.push(payload);
    });
    const task = {
      ...makeTask(),
      approvalPayload: { action: "continue_user_message", message: "prepare a fix" },
    };

    await provider.start(task, makeExecution(), []);

    expect(dispatches[0].inputs.approval_payload).toBe(JSON.stringify(task.approvalPayload));
    expect(dispatches[0].inputs.event_type).toBe("github.ci.failed");
    expect(dispatches[0].inputs.payload).toBe(JSON.stringify(eventPayload));
  });

  test("dispatches bounded Mind memory as read-only worker context", async () => {
    const dispatches: Array<{ ref: string; inputs: Record<string, string> }> = [];
    const provider = makeProvider(async (_workflowFile, payload) => {
      dispatches.push(payload);
    });
    const memoryContext: MemoryContextEntry[] = [{
      type: "fact",
      content: { statement: "The project uses Bun." },
    }];

    await provider.start(makeTask(), makeExecution(), memoryContext);

    expect(dispatches[0].inputs.memory_context).toBe(JSON.stringify(memoryContext));
  });

  test("worker requests approval and continues the same user task after approval", async () => {
    const octokit = new Octokit({ auth: "test-token" });
    const payload = { message: "prepare a fix", requiresApproval: true };
    const requested = await executeWorkerTask({
      eventType: "user.message",
      payload,
      octokit,
      owner: "test-owner",
      repo: "test-repo",
    });

    const emptyContext = await executeWorkerTask({
      eventType: "user.message",
      payload,
      approvalPayload: {},
      octokit,
      owner: "test-owner",
      repo: "test-repo",
    });
    expect(emptyContext).toEqual(requested);

    expect(requested).toEqual({
      status: "approval_required",
      approvalPayload: {
        action: "continue_user_message",
        message: "prepare a fix",
      },
    });

    const resumed = await executeWorkerTask({
      eventType: "user.message",
      payload,
      approvalPayload: {
        action: "continue_user_message",
        message: "prepare a fix",
      },
      octokit,
      owner: "test-owner",
      repo: "test-repo",
    });
    expect(resumed).toBe("Continued after human approval: prepare a fix");
  });

  test("reports worker task exceptions as failed results", async () => {
    const reported: WorkerOutcome[] = [];
    const outcome = await executeAndReport(
      async () => { throw new Error("GitHub API request failed"); },
      async (result) => { reported.push(result); }
    );

    expect(outcome).toEqual({ status: "failed", error: "GitHub API request failed" });
    expect(reported).toEqual([{ status: "failed", error: "GitHub API request failed" }]);
  });

  test("reports an approval request instead of a completed task result", async () => {
    const approvalRequest = {
      status: "approval_required" as const,
      approvalPayload: { action: "continue_user_message", message: "prepare a fix" },
    };
    const reported: WorkerOutcome[] = [];
    const outcome = await executeAndReport(
      async () => approvalRequest,
      async (result) => { reported.push(result); }
    );

    expect(outcome).toEqual(approvalRequest);
    expect(reported).toEqual([approvalRequest]);
  });
});