import "dotenv/config";
import { Octokit } from "@octokit/rest";
import { closePool, query } from "../../packages/db/src/client.ts";

interface DeliveryCorrelation {
  event_id: string;
  event_type: string;
  processed: boolean;
  task_id: string | null;
  task_status: string | null;
  execution_id: string | null;
  execution_status: string | null;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}

async function main(): Promise<void> {
  try {
    const token = requiredEnv("GITHUB_TOKEN");
    const owner = requiredEnv("GITHUB_OWNER");
    const repo = requiredEnv("GITHUB_REPO");
    const expectedWebhookUrl = process.env.NGROK_URL
      ? normalizeUrl(new URL("/events", process.env.NGROK_URL).toString())
      : null;
    const configuredHookId = process.env.GITHUB_WEBHOOK_ID;
    const octokit = new Octokit({ auth: token });
    const { data: hooks } = await octokit.repos.listWebhooks({ owner, repo, per_page: 100 });

    const hook = configuredHookId
      ? hooks.find((candidate) => candidate.id === Number(configuredHookId))
      : hooks.find((candidate) =>
          candidate.config.url && normalizeUrl(candidate.config.url) === expectedWebhookUrl
        );

    if (!hook) {
      throw new Error(
        configuredHookId
          ? `Webhook ${configuredHookId} was not found in ${owner}/${repo}`
          : "No webhook matched NGROK_URL/events. Set GITHUB_WEBHOOK_ID to select a hook explicitly."
      );
    }
    if (!hook.active) {
      throw new Error(`Webhook ${hook.id} is inactive`);
    }

    const { data: deliveries } = await octokit.repos.listWebhookDeliveries({
      owner,
      repo,
      hook_id: hook.id,
      per_page: 100,
    });

    const candidateDeliveries = deliveries.filter((delivery) =>
      delivery.status_code >= 200 &&
      delivery.status_code < 400 &&
      (delivery.event === "workflow_run" || delivery.event === "pull_request")
    );
    if (candidateDeliveries.length === 0) {
      throw new Error("No recent successful workflow_run or pull_request delivery was found");
    }

    const { rows } = await query<DeliveryCorrelation>(
      `SELECT e.id AS event_id, e.type AS event_type, e.processed,
              t.id AS task_id, t.status AS task_status,
              x.id AS execution_id, x.status AS execution_status
       FROM events e
       LEFT JOIN tasks t ON t.event_id = e.id
       LEFT JOIN LATERAL (
         SELECT id, status
         FROM executions
         WHERE task_id = t.id
         ORDER BY started_at DESC
         LIMIT 1
       ) x ON t.id IS NOT NULL
       WHERE e.id = ANY($1::text[])
       ORDER BY t.created_at DESC`,
      [candidateDeliveries.map((delivery) => delivery.guid)]
    );

    const correlationsByGuid = new Map<string, DeliveryCorrelation>();
    for (const row of rows) {
      correlationsByGuid.set(row.event_id, row);
    }

    const selectedDelivery = candidateDeliveries.find((delivery) => correlationsByGuid.has(delivery.guid));
    if (!selectedDelivery) {
      throw new Error("No recent successful workflow_run or pull_request delivery has a persisted event");
    }

    const correlation = correlationsByGuid.get(selectedDelivery.guid);
    if (!correlation) {
      throw new Error(`No persisted event matched delivery ${selectedDelivery.guid}`);
    }
    const expectedEventType = selectedDelivery.event === "workflow_run"
      ? "github.ci.failed"
      : "github.pull_request.opened";
    if (correlation.event_type !== expectedEventType || !correlation.processed) {
      throw new Error(`GitHub delivery ${selectedDelivery.guid} did not produce the expected processed event`);
    }
    if (
      !correlation.task_id ||
      correlation.task_status !== "completed" ||
      !correlation.execution_id ||
      correlation.execution_status !== "completed"
    ) {
      throw new Error(`Event ${correlation.event_id} exists, but its task or execution is not completed`);
    }

    console.log(`Repository: ${owner}/${repo}`);
    console.log(`Webhook ID: ${hook.id}`);
    console.log(`Delivery: ${selectedDelivery.guid}`);
    console.log(`GitHub event: ${selectedDelivery.event}${selectedDelivery.action ? `.${selectedDelivery.action}` : ""}`);
    console.log(`Delivered at: ${selectedDelivery.delivered_at} (HTTP ${selectedDelivery.status_code})`);
    console.log(`Recent successful candidate deliveries: ${candidateDeliveries.length}`);
    console.log(`Mind event: ${correlation.event_id} (${correlation.event_type}, processed)`);
    console.log(`Task: ${correlation.task_id} (${correlation.task_status})`);
    console.log(`Execution: ${correlation.execution_id} (${correlation.execution_status})`);
  } finally {
    await closePool();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Webhook correlation failed");
  process.exitCode = 1;
});