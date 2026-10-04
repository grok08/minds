import { Octokit } from "@octokit/rest";
import { GitHubEventPayload } from "../../runtime/src/domain/types.ts";

interface WorkerEnv {
  TASK_ID: string;
  EXECUTION_ID: string;
  EVENT_TYPE: string;
  PAYLOAD: string;
  MINDS_SERVER_URL: string;
  MINDS_CALLBACK_SECRET: string;
  GITHUB_TOKEN: string;
  GITHUB_REPOSITORY: string;
}

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
  ];
  const env: Record<string, string> = {};
  for (const key of required) {
    const value = process.env[key];
    if (!value) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
    env[key] = value;
  }
  return env as unknown as WorkerEnv;
}

async function reportResult(
  serverUrl: string,
  callbackSecret: string,
  executionId: string,
  taskId: string,
  status: "completed" | "failed",
  result?: string,
  error?: string
): Promise<void> {
  const body = JSON.stringify({ taskId, status, result, error });
  const response = await fetch(`${serverUrl}/executions/${executionId}/result`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Minds-Callback-Secret": callbackSecret,
    },
    body,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to report result: ${response.status} ${text}`);
  }
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

  try {
    const logs = await octokit.actions.downloadWorkflowRunLogs({
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
  } catch (error) {
    return `Failed to investigate CI failure: ${error instanceof Error ? error.message : String(error)}`;
  }
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

  try {
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
  } catch (error) {
    return `Failed to analyze PR: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function handleUserMessage(payload: GitHubEventPayload): Promise<string> {
  return `Received user message: ${JSON.stringify(payload)}`;
}

async function main() {
  const env = getEnv();
  const [owner, repo] = env.GITHUB_REPOSITORY.split("/");
  const octokit = new Octokit({ auth: env.GITHUB_TOKEN });

  let payload: GitHubEventPayload = {};
  try {
    payload = JSON.parse(env.PAYLOAD);
  } catch {
    // Payload might not be valid JSON
  }

  try {
    let result: string;
    switch (env.EVENT_TYPE) {
      case "github.ci.failed":
        result = await investigateCIFailure(octokit, owner, repo, payload);
        break;
      case "github.pull_request.opened":
        result = await analyzePullRequest(octokit, owner, repo, payload);
        break;
      case "user.message":
        result = await handleUserMessage(payload);
        break;
      default:
        result = `Handled ${env.EVENT_TYPE}`;
    }

    await reportResult(
      env.MINDS_SERVER_URL,
      env.MINDS_CALLBACK_SECRET,
      env.EXECUTION_ID,
      env.TASK_ID,
      "completed",
      result
    );
    console.log("Worker completed successfully");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Worker failed:", message);
    await reportResult(
      env.MINDS_SERVER_URL,
      env.MINDS_CALLBACK_SECRET,
      env.EXECUTION_ID,
      env.TASK_ID,
      "failed",
      undefined,
      message
    );
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});