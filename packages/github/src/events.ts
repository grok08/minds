import { MindEvent } from "../../runtime/src/domain/types.ts";
import { parseWebhookEvent, mapGitHubEventToInternal, verifySignature } from "./webhooks.ts";

export interface GitHubEventRouterConfig {
  webhookSecret: string;
  repositoryFullName: string;
}

export class InvalidWebhookSignatureError extends Error {
  constructor() {
    super("Invalid webhook signature");
    this.name = "InvalidWebhookSignatureError";
  }
}

export class GitHubEventRouter {
  private readonly config: GitHubEventRouterConfig;

  constructor(config: GitHubEventRouterConfig) {
    this.config = config;
  }

  async routeRequest(
    headers: Record<string, string | undefined>,
    rawPayload: string
  ): Promise<MindEvent | null> {
    const parsed = parseWebhookEvent(headers, rawPayload);
    if (!parsed) {
      return null;
    }

    if (!verifySignature(rawPayload, parsed.signature, this.config.webhookSecret)) {
      throw new InvalidWebhookSignatureError();
    }

    const mapped = mapGitHubEventToInternal(parsed.eventType, parsed.payload);
    if (!mapped) {
      return null;
    }

    const repositoryFullName = parsed.payload.repository?.full_name;
    if (repositoryFullName?.toLowerCase() !== this.config.repositoryFullName.toLowerCase()) {
      return null;
    }

    return {
      id: headers["x-github-delivery"] || `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      type: mapped.type,
      payload: JSON.stringify(mapped.payload),
      mindId: mapped.mindId,
    };
  }
}

export function createGitHubEventRouter(config: GitHubEventRouterConfig): GitHubEventRouter {
  return new GitHubEventRouter(config);
}