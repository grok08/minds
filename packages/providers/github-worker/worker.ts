import { Octokit } from "@octokit/rest";
import type { GitHubEventPayload } from "../../runtime/src/domain/types.ts";
import { parseMemoryContext } from "../../memory/src/types.ts";
import type { MemoryContextEntry } from "../../memory/src/types.ts";

interface WorkerEnv {
  TASK_ID: string;
  EXECUTION_ID: string;
  EVENT_TYPE: string;
  PAYLOAD: string;
  APPROVAL_PAYLOAD: string;
  MEMORY_CONTEXT: string;
  MINDS_SERVER_URL: string;
  MINDS_CALLBACK_SECRET: string;
  GITHUB_TOKEN: string;
  GITHUB_REPOSITORY: string;
  GITHUB_RUN_ID: string;
}

export type WorkerOutcome =
  | { status: "approval_required"; approvalPayload: Record<string, unknown> }
  | { status: "completed"; result: string }
  | { status: "failed"; error: string };

type WorkerTaskResult = string | Extract<WorkerOutcome, { status: "approval_required" }>;

function getEnv(): WorkerEnv {
  const required = [
    "TASK_ID",
    "EXECUTION_ID",
    "EVENT_TYPE",
    "PAYLOAD",
    "MINDS_SERVER_URL",
    "MINDS_CALLBACK_SECRET",
    "GITHUB_TOKEN",
    "GITHUB_REPOSITORY",
    "GITHUB_RUN_ID",
  ];
  const env: Record<string, string> = {};
  for (const key of required) {
    const value = process.env[key];
    if (!value) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
    env[key] = value;
  }
  env.APPROVAL_PAYLOAD = process.env.APPROVAL_PAYLOAD ?? "{}";
  env.MEMORY_CONTEXT = process.env.MEMORY_CONTEXT ?? "[]";
  return env as unknown as WorkerEnv;
}

async function reportRunId(
  serverUrl: string,
  callbackSecret: string,
  executionId: string,
  taskId: string,
  workflowRunId: number
): Promise<void> {
  const body = JSON.stringify({ taskId, workflowRunId });
  const response = await fetch(`${serverUrl}/executions/${executionId}/started`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Minds-Callback-Secret": callbackSecret,
    },
    body,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to register run ID: ${response.status} ${text}`);
  }
}

async function reportOutcome(
  serverUrl: string,
  callbackSecret: string,
  executionId: string,
  taskId: string,
  outcome: WorkerOutcome
): Promise<void> {
  const isApprovalRequest = outcome.status === "approval_required";
  const endpoint = isApprovalRequest ? "approval" : "result";
  const body = isApprovalRequest
    ? JSON.stringify({ taskId, approvalPayload: outcome.approvalPayload })
    : JSON.stringify({ taskId, ...outcome });
  const response = await fetch(`${serverUrl}/executions/${executionId}/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Minds-Callback-Secret": callbackSecret,
    },
    body,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to report worker outcome: ${response.status} ${text}`);
  }
}

export async function executeAndReport(
  executeTask: () => Promise<WorkerTaskResult>,
  report: (outcome: WorkerOutcome) => Promise<void>
): Promise<WorkerOutcome> {
  let outcome: WorkerOutcome;
  try {
    const result = await executeTask();
    outcome = typeof result === "string" ? { status: "completed", result } : result;
  } catch (error) {
    outcome = {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  await report(outcome);
  return outcome;
}

async function investigateCIFailure(
  octokit: Octokit,
  owner: string,
  repo: string,
  payload: GitHubEventPayload
): Promise<string> {
  if (!payload.runId || !payload.workflow) {
    return "CI failure investigation skipped: missing runId or workflow";
  }

  await octokit.actions.downloadWorkflowRunLogs({
    owner,
    repo,
    run_id: payload.runId,
  });
  const jobs = await octokit.actions.listJobsForWorkflowRun({
    owner,
    repo,
    run_id: payload.runId,
  });

  const failedJobs = jobs.data.jobs.filter((job) => job.conclusion === "failure");
  const summary = failedJobs
    .map((job) => `Job "${job.name}" failed`)
    .join("; ");

  return `Investigated CI failure for run ${payload.runId} in ${payload.workflow}. ${summary}. Logs retrieved.`;
}

async function analyzePullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  payload: GitHubEventPayload
): Promise<string> {
  if (!payload.prNumber) {
    return "PR analysis skipped: missing prNumber";
  }

  const pr = await octokit.pulls.get({
    owner,
    repo,
    pull_number: payload.prNumber,
  });
  const files = await octokit.pulls.listFiles({
    owner,
    repo,
    pull_number: payload.prNumber,
  });

  const fileSummary = files.data
    .map((f) => `${f.filename} (+${f.additions}/-${f.deletions})`)
    .slice(0, 10)
    .join("; ");

  return `Analyzed PR #${payload.prNumber}: ${payload.title || pr.data.title}. Files changed: ${fileSummary}${files.data.length > 10 ? "..." : ""}.`;
}

function handleUserMessage(payload: GitHubEventPayload): string {
  return `Received user message: ${JSON.stringify(payload)}`;
}

function continueUserMessage(
  payload: GitHubEventPayload,
  approvalPayload?: Record<string, unknown>
): WorkerTaskResult {
  if (approvalPayload && Object.keys(approvalPayload).length > 0) {
    if (approvalPayload.action !== "continue_user_message") {
      throw new Error("Unsupported approved continuation action");
    }
    return `Continued after human approval: ${String(approvalPayload.message ?? "")}`;
  }

  if (payload.requiresApproval) {
    return {
      status: "approval_required",
      approvalPayload: {
        action: "continue_user_message",
        message: payload.message ?? "",
      },
    };
  }

  return handleUserMessage(payload);
}

export async function executeWorkerTask(input: {
  eventType: string;
  payload: GitHubEventPayload;
  approvalPayload?: Record<string, unknown>;
  memoryContext?: MemoryContextEntry[];
  octokit: Octokit;
  owner: string;
  repo: string;
}): Promise<WorkerTaskResult> {
  switch (input.eventType) {
    case "github.ci.failed":
      return investigateCIFailure(input.octokit, input.owner, input.repo, input.payload);
    case "github.pull_request.opened":
      return analyzePullRequest(input.octokit, input.owner, input.repo, input.payload);
    case "user.message":
      return continueUserMessage(input.payload, input.approvalPayload);
    default:
      return `Handled ${input.eventType}`;
  }
}

function parseApprovalPayload(value: string): Record<string, unknown> | undefined {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || parsed === undefined) return undefined;
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("APPROVAL_PAYLOAD must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

async function main() {
  const env = getEnv();
  const [owner, repo] = env.GITHUB_REPOSITORY.split("/");
  const octokit = new Octokit({ auth: env.GITHUB_TOKEN });
  const workflowRunId = parseInt(env.GITHUB_RUN_ID, 10);

  let payload: GitHubEventPayload = {};
  try {
    payload = JSON.parse(env.PAYLOAD);
  } catch {
    // Payload might not be valid JSON
  }
  const approvalPayload = parseApprovalPayload(env.APPROVAL_PAYLOAD);

  // Register the workflow run ID immediately
  try {
    await reportRunId(
      env.MINDS_SERVER_URL,
      env.MINDS_CALLBACK_SECRET,
      env.EXECUTION_ID,
      env.TASK_ID,
      workflowRunId
    );
    console.log(`Registered workflow run ID: ${workflowRunId}`);
  } catch (error) {
    console.error("Failed to register run ID:", error);
  }

  const outcome = await executeAndReport(async () => {
    const memoryContext = parseMemoryContext(JSON.parse(env.MEMORY_CONTEXT));
    return executeWorkerTask({
      eventType: env.EVENT_TYPE,
      payload,
      approvalPayload,
      memoryContext,
      octokit,
      owner,
      repo,
    });
  }, (result) => reportOutcome(
      env.MINDS_SERVER_URL,
      env.MINDS_CALLBACK_SECRET,
      env.EXECUTION_ID,
      env.TASK_ID,
      result
    ));

  if (outcome.status === "failed") {
    console.error("Worker failed:", outcome.error);
    process.exitCode = 1;
  } else {
    console.log("Worker completed successfully");
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exitCode = 1;
  });
}