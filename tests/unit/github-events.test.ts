import { describe, expect, test } from "bun:test";
import { createGitHubEventRouter } from "../../packages/github/src/events.ts";

describe("GitHub Event Router", () => {
  const secret = "test-secret";
  const router = createGitHubEventRouter({
    webhookSecret: secret,
    repositoryFullName: "owner/repo",
  });

  function createSignedPayload(payload: object) {
    const rawPayload = JSON.stringify(payload);
    const crypto = require("crypto");
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(rawPayload);
    const signature = `sha256=${hmac.digest("hex")}`;
    return { rawPayload, signature };
  }

  test("routeRequest - valid workflow_run.failed", async () => {
    const payload = {
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
    };

    const { rawPayload, signature } = createSignedPayload(payload);
    const headers = {
      "x-github-event": "workflow_run",
      "x-hub-signature-256": signature,
      "x-github-delivery": "delivery-123",
    };

    const event = await router.routeRequest(headers, rawPayload);

    expect(event).not.toBeNull();
    expect(event?.type).toBe("github.ci.failed");
    expect(event?.mindId).toBe("repository");
    expect(event?.id).toBe("delivery-123");
    expect(event?.payload).toContain("CI");
    expect(event?.payload).toContain("123");
  });

  test("routeRequest - invalid signature rejected", async () => {
    const payload = { action: "completed", workflow_run: { id: 123, conclusion: "failure" }};
    const rawPayload = JSON.stringify(payload);
    const headers = {
      "x-github-event": "workflow_run",
      "x-hub-signature-256": "sha256=invalid"
    };

    await expect(router.routeRequest(headers, rawPayload)).rejects.toThrow("Invalid webhook signature");
  });

  test("routeRequest - missing x-github-event returns null", async () => {
    const payload = { action: "completed" };
    const rawPayload = JSON.stringify(payload);
    const crypto = require("crypto");
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(rawPayload);
    const signature = `sha256=${hmac.digest("hex")}`;

    const headers = { "x-hub-signature-256": signature };
    const event = await router.routeRequest(headers, rawPayload);

    expect(event).toBeNull();
  });

  test("routeRequest - pull_request.opened", async () => {
    const payload = {
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

    const { rawPayload, signature } = createSignedPayload(payload);
    const headers = {
      "x-github-event": "pull_request",
      "x-hub-signature-256": signature
    };

    const event = await router.routeRequest(headers, rawPayload);

    expect(event).not.toBeNull();
    expect(event?.type).toBe("github.pull_request.opened");
    expect(event?.payload).toContain("42");
    expect(event?.payload).toContain("Fix tests");
  });

  test("routeRequest - ignores events from a different repository", async () => {
    const payload = {
      action: "completed",
      workflow_run: {
        id: 123,
        name: "CI",
        head_branch: "main",
        head_sha: "abc123",
        conclusion: "failure",
        status: "completed",
        html_url: "https://github.com/other/repo/actions/runs/123",
        repository: { full_name: "other/repo" },
      },
      repository: { full_name: "other/repo" },
    };
    const { rawPayload, signature } = createSignedPayload(payload);

    const event = await router.routeRequest(
      {
        "x-github-event": "workflow_run",
        "x-hub-signature-256": signature,
      },
      rawPayload,
    );

    expect(event).toBeNull();
  });

  test("routeRequest - unknown event type returns null", async () => {
    const payload = { action: "created" };
    const { rawPayload, signature } = createSignedPayload(payload);
    const headers = {
      "x-github-event": "star",
      "x-hub-signature-256": signature
    };

    const event = await router.routeRequest(headers, rawPayload);

    expect(event).toBeNull();
  });
});