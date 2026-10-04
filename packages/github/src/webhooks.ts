import { createHmac, timingSafeEqual } from "crypto";

export interface WebhookPayload {
  action?: string;
  workflow_run?: {
    id: number;
    name: string;
    head_branch: string;
    head_sha: string;
    conclusion: string;
    status: string;
    html_url: string;
    repository: {
      full_name: string;
    };
  };
  pull_request?: {
    number: number;
    title: string;
    head: {
      sha: string;
      ref: string;
    };
    base: {
      ref: string;
    };
    html_url: string;
    repository: {
      full_name: string;
    };
  };
  repository?: {
    full_name: string;
  };
}

export interface ParsedWebhook {
  eventType: string;
  payload: WebhookPayload;
  signature: string;
}

export function verifySignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const hmac = createHmac("sha256", secret);
  hmac.update(payload);
  const expectedSignature = `sha256=${hmac.digest("hex")}`;

  if (signature.length !== expectedSignature.length) {
    return false;
  }

  return timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

export function parseWebhookEvent(
  headers: Record<string, string | undefined>,
  payload: string
): ParsedWebhook | null {
  const eventType = headers["x-github-event"];
  const signature = headers["x-hub-signature-256"] || "";

  if (!eventType) {
    return null;
  }

  try {
    const parsedPayload = JSON.parse(payload) as WebhookPayload;
    return {
      eventType,
      payload: parsedPayload,
      signature,
    };
  } catch {
    return null;
  }
}

export function mapGitHubEventToInternal(
  eventType: string,
  payload: WebhookPayload
): { type: string; mindId: string; payload: Record<string, unknown> } | null {
  switch (eventType) {
    case "workflow_run": {
      const run = payload.workflow_run;
      if (!run) return null;

      if (run.conclusion === "failure" || run.conclusion === "cancelled" || run.conclusion === "timed_out") {
        return {
          type: "github.ci.failed",
          mindId: "repository",
          payload: {
            repository: payload.repository?.full_name || "",
            workflow: run.name,
            runId: run.id,
            branch: run.head_branch,
            sha: run.head_sha,
            conclusion: run.conclusion,
            url: run.html_url,
          },
        };
      }
      return null;
    }

    case "pull_request": {
      const pr = payload.pull_request;
      if (!pr) return null;

      if (payload.action === "opened" || payload.action === "reopened" || payload.action === "synchronize") {
        return {
          type: "github.pull_request.opened",
          mindId: "repository",
          payload: {
            repository: payload.repository?.full_name || "",
            prNumber: pr.number,
            title: pr.title,
            headSha: pr.head.sha,
            headRef: pr.head.ref,
            baseRef: pr.base.ref,
            url: pr.html_url,
          },
        };
      }
      return null;
    }

    default:
      return null;
  }
}