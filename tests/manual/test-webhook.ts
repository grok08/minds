import { createHmac } from "crypto";

const WEBHOOK_SECRET = "dev-secret";
const SERVER_URL = "http://localhost:3000";

function signPayload(payload: string): string {
  const hmac = createHmac("sha256", WEBHOOK_SECRET);
  hmac.update(payload);
  return `sha256=${hmac.digest("hex")}`;
}

async function testWorkflowRunFailed() {
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
      repository: {
        full_name: "owner/repo"
      }
    },
    repository: {
      full_name: "owner/repo"
    }
  };

  const rawPayload = JSON.stringify(payload);
  const signature = signPayload(rawPayload);

  console.log("Testing workflow_run.failed event...");
  
  const response = await fetch(`${SERVER_URL}/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": "workflow_run",
      "X-Hub-Signature-256": signature,
      "X-GitHub-Delivery": "test-delivery-1"
    },
    body: rawPayload
  });

  const result = await response.json();
  console.log("Response:", response.status, result);
}

async function testPullRequestOpened() {
  const payload = {
    action: "opened",
    pull_request: {
      number: 42,
      title: "Fix failing tests",
      head: {
        sha: "def456abc123",
        ref: "fix-tests"
      },
      base: {
        ref: "main"
      },
      html_url: "https://github.com/owner/repo/pull/42",
      repository: {
        full_name: "owner/repo"
      }
    },
    repository: {
      full_name: "owner/repo"
    }
  };

  const rawPayload = JSON.stringify(payload);
  const signature = signPayload(rawPayload);

  console.log("\nTesting pull_request.opened event...");
  
  const response = await fetch(`${SERVER_URL}/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": "pull_request",
      "X-Hub-Signature-256": signature,
      "X-GitHub-Delivery": "test-delivery-2"
    },
    body: rawPayload
  });

  const result = await response.json();
  console.log("Response:", response.status, result);
}

async function testHealth() {
  console.log("Testing health endpoint...");
  const response = await fetch(`${SERVER_URL}/health`);
  const result = await response.json();
  console.log("Health:", result);
}

async function testGetMinds() {
  console.log("\nTesting GET /minds...");
  const response = await fetch(`${SERVER_URL}/minds`);
  const result = await response.json();
  console.log("Minds:", result);
}

async function runTests() {
  await testHealth();
  await testGetMinds();
  await testWorkflowRunFailed();
  await testPullRequestOpened();
  
  console.log("\nAll tests completed!");
}

runTests().catch(console.error);