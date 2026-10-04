import { createHmac } from "crypto";

const WEBHOOK_SECRET = "dev-secret";
const SERVER_URL = "http://localhost:3000";

function signPayload(payload: string): string {
  const hmac = createHmac("sha256", WEBHOOK_SECRET);
  hmac.update(payload);
  return `sha256=${hmac.digest("hex")}`;
}

async function sendWorkflowRunFailed() {
  const payload = {
    action: "completed",
    workflow_run: {
      id: 123456789,
      name: "CI",
      head_branch: "main",
      head_sha: "abc123def456",
      conclusion: "failure",
      status: "completed",
      html_url: "https://github.com/owner/repo/actions/runs/123456789",
      repository: { full_name: "owner/repo" }
    },
    repository: { full_name: "owner/repo" }
  };

  const rawPayload = JSON.stringify(payload);
  const signature = signPayload(rawPayload);

  const response = await fetch(`${SERVER_URL}/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": "workflow_run",
      "X-Hub-Signature-256": signature,
      "X-GitHub-Delivery": "test-delivery-idempotent"
    },
    body: rawPayload
  });

  const result = await response.json();
  console.log("Response:", response.status, result);
  return result;
}

async function runTest() {
  console.log("First request:");
  await sendWorkflowRunFailed();
  
  console.log("\nSecond request (same delivery ID):");
  await sendWorkflowRunFailed();
  
  console.log("\nChecking database...");
}

runTest().catch(console.error);