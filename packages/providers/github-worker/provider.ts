import type { AgentProvider, ExecutionStatus } from "../provider.ts";
import type { Task, Execution, GitHubEventPayload } from "../../runtime/src/domain/types.ts";
import type { MemoryContextEntry } from "../../memory/src/types.ts";
import { createGitHubClient, GitHubClient, GitHubConfig } from "../../github/src/client.ts";

export interface GitHubWorkerConfig {
  github: GitHubConfig;
  mindsServerUrl: string;
  mindsCallbackSecret: string;
}

interface GitHubWorkerClient {
  dispatchWorkflow(workflowFile: string, payload: { ref: string; inputs: Record<string, string> }): Promise<void>;
  getWorkflowRun(runId: number): Promise<{ status: string | null; conclusion: string | null }>;
  cancelWorkflowRun(runId: number): Promise<void>;
}

export class GitHubWorkerProvider implements AgentProvider {
  private readonly githubClient: GitHubWorkerClient;
  private readonly mindsServerUrl: string;
  private readonly mindsCallbackSecret: string;

  constructor(config: GitHubWorkerConfig, githubClient: GitHubWorkerClient = createGitHubClient(config.github)) {
    this.githubClient = githubClient;
    this.mindsServerUrl = config.mindsServerUrl;
    this.mindsCallbackSecret = config.mindsCallbackSecret;
  }

  async start(
    task: Task,
    execution: Execution,
    memoryContext: MemoryContextEntry[]
  ): Promise<Execution> {
    execution.status = "running";
    execution.startedAt = new Date();

    const payload = this.parsePayload(task);
    await this.dispatchWorkflow(task, execution, payload, memoryContext);
    execution.status = "running";
    
    return execution;
  }

  async registerWorkflowRunId(executionId: string, taskId: string, workflowRunId: number): Promise<void> {
    const url = `${this.mindsServerUrl}/executions/${executionId}/started`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Minds-Callback-Secret": this.mindsCallbackSecret,
      },
      body: JSON.stringify({ taskId, workflowRunId }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to register workflow run ID: ${response.status} ${text}`);
    }
  }

  async status(execution: Execution): Promise<ExecutionStatus> {
    if (!execution.workflowRunId) {
      return execution.status;
    }

    try {
      const run = await this.githubClient.getWorkflowRun(execution.workflowRunId);
      switch (run.status) {
        case "completed":
          if (run.conclusion === "success") {
            return "completed";
          }
          return "failed";
        case "in_progress":
        case "queued":
        case "waiting":
          return "running";
        default:
          return "running";
      }
    } catch {
      return execution.status;
    }
  }

  async stop(execution: Execution): Promise<void> {
    if (execution.workflowRunId) {
      try {
        await this.githubClient.cancelWorkflowRun(execution.workflowRunId);
      } catch {
        // Ignore cancellation errors
      }
    }
  }

  private async dispatchWorkflow(
    task: Task,
    execution: Execution,
    payload: GitHubEventPayload,
    memoryContext: MemoryContextEntry[]
  ): Promise<void> {
    const dispatchPayload = {
      ref: "main",
      inputs: {
        task_id: task.id,
        execution_id: execution.id,
        event_type: task.type,
        payload: JSON.stringify(payload),
        memory_context: JSON.stringify(memoryContext),
        minds_server_url: this.mindsServerUrl,
        ...(task.approvalPayload
          ? { approval_payload: JSON.stringify(task.approvalPayload) }
          : {}),
      },
    };

    await this.githubClient.dispatchWorkflow("minds-worker.yml", dispatchPayload);
  }

  private parsePayload(task: Task): GitHubEventPayload {
    const prefix = `${task.type}: `;
    const description = task.description.startsWith(prefix)
      ? task.description.slice(prefix.length)
      : task.description;

    try {
      const parsed = JSON.parse(description);
      if (typeof parsed === "object" && parsed !== null) {
        return parsed as GitHubEventPayload;
      }
    } catch {
      // Description might not be JSON
    }
    return {};
  }
}

export function createGitHubWorkerProvider(config: GitHubWorkerConfig): GitHubWorkerProvider {
  return new GitHubWorkerProvider(config);
}