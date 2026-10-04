import { describe, expect, test } from "bun:test";
import {
  verifySignature,
  parseWebhookEvent,
  mapGitHubEventToInternal,
} from "../../packages/github/src/webhooks.ts";

describe("GitHub Webhooks", () => {
  const secret = "test-secret";
  const payload = JSON.stringify({
    action: "completed",
    workflow_run: {
      id: 123,
      name: "CI",
      head_branch: "main",
      head_sha: "abc123",
      conclusion: "failure",
      status: "completed",
      html_url: "https://github.com/owner/repo/actions/runs/123",
      repository: { full_name: "owner/repo" }
    },
    repository: { full_name: "owner/repo" }
  });

  test("verifySignature - valid signature", () => {
    const hmac = createHmac("sha256", secret);
    hmac.update(payload);
    const signature = `sha256=${hmac.digest("hex")}`;
    
    expect(verifySignature(payload, signature, secret)).toBe(true);
  });

  test("verifySignature - invalid signature", () => {
    expect(verifySignature(payload, "sha256=invalid", secret)).toBe(false);
  });

  test("parseWebhookEvent - valid workflow_run", () => {
    const headers = {
      "x-github-event": "workflow_run",
      "x-hub-signature-256": ""
    };
    
    const result = parseWebhookEvent(headers, payload);
    
    expect(result).not.toBeNull();
    expect(result?.eventType).toBe("workflow_run");
    expect(result?.payload.workflow_run?.id).toBe(123);
  });

  test("parseWebhookEvent - missing event type", () => {
    const headers = { "x-hub-signature-256": "" };
    
    const result = parseWebhookEvent(headers, payload);
    
    expect(result).toBeNull();
  });

  test("mapGitHubEventToInternal - workflow_run.failed", () => {
    const eventType = "workflow_run";
    const parsedPayload = JSON.parse(payload);
    
    const result = mapGitHubEventToInternal(eventType, parsedPayload);
    
    expect(result).not.toBeNull();
    expect(result?.type).toBe("github.ci.failed");
    expect(result?.mindId).toBe("repository");
    expect(result?.payload.workflow).toBe("CI");
    expect(result?.payload.runId).toBe(123);
    expect(result?.payload.conclusion).toBe("failure");
  });

  test("mapGitHubEventToInternal - workflow_run.success ignored", () => {
    const eventType = "workflow_run";
    const successPayload = {
      ...JSON.parse(payload),
      workflow_run: { ...JSON.parse(payload).workflow_run, conclusion: "success" }
    };
    
    const result = mapGitHubEventToInternal(eventType, successPayload);
    
    expect(result).toBeNull();
  });

  test("mapGitHubEventToInternal - pull_request.opened", () => {
    const eventType = "pull_request";
    const prPayload = {
      action: "opened",
      pull_request: {
        number: 42,
        title: "Fix tests",
        head: { sha: "def456", ref: "fix-tests" },
        base: { ref: "main" },
        html_url: "https://github.com/owner/repo/pull/42",
        repository: { full_name: "owner/repo" }
      },
      repository: { full_name: "owner/repo" }
    };
    
    const result = mapGitHubEventToInternal(eventType, prPayload);
    
    expect(result).not.toBeNull();
    expect(result?.type).toBe("github.pull_request.opened");
    expect(result?.payload.prNumber).toBe(42);
    expect(result?.payload.title).toBe("Fix tests");
  });

  test("mapGitHubEventToInternal - pull_request.closed ignored", () => {
    const eventType = "pull_request";
    const closedPayload = {
      action: "closed",
      pull_request: {
        number: 42,
        title: "Fix tests",
        head: { sha: "def456", ref: "fix-tests" },
        base: { ref: "main" },
        html_url: "https://github.com/owner/repo/pull/42",
        repository: { full_name: "owner/repo" }
      },
      repository: { full_name: "owner/repo" }
    };
    
    const result = mapGitHubEventToInternal(eventType, closedPayload);
    
    expect(result).toBeNull();
  });
});

function createHmac(algorithm: string, key: string) {
  const crypto = require("crypto");
  return crypto.createHmac(algorithm, key);
}