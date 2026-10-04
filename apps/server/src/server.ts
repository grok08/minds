import Fastify from "fastify";
import { query, transaction, closePool } from "../../../packages/db/src/client.ts";
import { PersistentMindRuntime } from "../../../packages/runtime/src/runtime.ts";
import { createGitHubEventRouter, InvalidWebhookSignatureError } from "../../../packages/github/src/events.ts";
import { createGitHubWorkerProvider } from "../../../packages/providers/github-worker/provider.ts";
import { generateId, toRepository } from "../../../packages/runtime/src/domain/types.ts";

const server = Fastify({ logger: true });
const rawBodies = new WeakMap<object, Buffer>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

server.removeContentTypeParser("application/json");
server.addContentTypeParser(
  "application/json",
  { parseAs: "buffer" },
  (request, body, done) => {
    const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
    rawBodies.set(request, rawBody);
    try {
      done(null, JSON.parse(rawBody.toString("utf8")));
    } catch (error) {
      done(error instanceof Error ? error : new Error("Invalid JSON payload"));
    }
  },
);

const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_OWNER = process.env.GITHUB_OWNER || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "";
const MIND_ID = process.env.MIND_ID || "repository";
const MINDS_CALLBACK_SECRET = process.env.MINDS_CALLBACK_SECRET;
const MINDS_SERVER_URL = process.env.MINDS_SERVER_URL || `http://localhost:${process.env.PORT || "3000"}`;

if (!GITHUB_WEBHOOK_SECRET) {
  throw new Error("GITHUB_WEBHOOK_SECRET is required");
}
if (!GITHUB_OWNER || !GITHUB_REPO) {
  throw new Error("GITHUB_OWNER and GITHUB_REPO are required");
}
if (!MINDS_CALLBACK_SECRET) {
  throw new Error("MINDS_CALLBACK_SECRET is required");
}

const githubEventRouter = createGitHubEventRouter({
  webhookSecret: GITHUB_WEBHOOK_SECRET,
  repositoryFullName: `${GITHUB_OWNER}/${GITHUB_REPO}`,
});

const githubWorkerProvider = createGitHubWorkerProvider({
  github: {
    token: GITHUB_TOKEN,
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
  },
  mindsServerUrl: MINDS_SERVER_URL,
  mindsCallbackSecret: MINDS_CALLBACK_SECRET,
});

const mindRuntime = new PersistentMindRuntime(MIND_ID, githubWorkerProvider);

async function initializeRuntime() {
  await mindRuntime.initialize();
  
  if (GITHUB_OWNER && GITHUB_REPO && GITHUB_TOKEN) {
    await ensureRepositoryConfig();
  }

  mindRuntime.startPolling();
}

async function ensureRepositoryConfig() {
  const existing = await query<{ id: string }>(
    "SELECT id FROM repositories WHERE mind_id = $1",
    [MIND_ID]
  );

  if (existing.rows.length === 0) {
    await query(
      `INSERT INTO repositories (id, mind_id, github_owner, github_repo, webhook_secret, github_token, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        generateId("repo"),
        MIND_ID,
        GITHUB_OWNER,
        GITHUB_REPO,
        GITHUB_WEBHOOK_SECRET,
        GITHUB_TOKEN,
        new Date(),
        new Date(),
      ]
    );
  } else {
    await query(
      `UPDATE repositories
       SET github_owner = $1, github_repo = $2, webhook_secret = $3, github_token = $4, updated_at = $5
       WHERE mind_id = $6`,
      [GITHUB_OWNER, GITHUB_REPO, GITHUB_WEBHOOK_SECRET, GITHUB_TOKEN, new Date(), MIND_ID]
    );
  }
}

async function getRepositoryConfig() {
  const result = await query(
    "SELECT * FROM repositories WHERE mind_id = $1",
    [MIND_ID]
  );
  if (result.rows.length === 0) return null;
  return toRepository(result.rows[0]);
}

async function handleGitHubEvent(event: { type: string; payload: string; mindId?: string; id: string }) {
  await mindRuntime.handleEvent(
    {
      id: event.id,
      type: event.type,
      payload: event.payload,
      mindId: event.mindId || MIND_ID,
    }
  );
}

server.post("/events", async (request, reply) => {
  try {
    const headers = request.headers as Record<string, string | undefined>;
    const rawBody = rawBodies.get(request);
    if (!rawBody) {
      return reply.code(400).send({ error: "Missing raw request body" });
    }
    const rawPayload = rawBody.toString("utf8");

    const event = await githubEventRouter.routeRequest(headers, rawPayload);
    
    if (!event) {
      return reply.code(202).send({ message: "Event not relevant or not mapped" });
    }

    await handleGitHubEvent(event);
    
    return reply.code(200).send({ message: "Event processed", eventId: event.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    server.log.error(error);
    if (error instanceof InvalidWebhookSignatureError) {
      return reply.code(401).send({ error: message });
    }
    return reply.code(500).send({ error: message });
  }
});

server.post("/messages", async (request, reply) => {
  if (!isRecord(request.body)) {
    return reply.code(400).send({ error: "Invalid message body" });
  }

  const { message, requiresApproval } = request.body;
  if (typeof message !== "string" || !message.trim()) {
    return reply.code(400).send({ error: "message must be a non-empty string" });
  }
  if (requiresApproval !== undefined && typeof requiresApproval !== "boolean") {
    return reply.code(400).send({ error: "requiresApproval must be a boolean" });
  }

  const eventId = generateId("user-message");
  try {
    await mindRuntime.handleEvent({
      id: eventId,
      type: "user.message",
      payload: JSON.stringify({ message, requiresApproval: requiresApproval === true }),
      mindId: MIND_ID,
    });
    return reply.code(202).send({ message: "User message accepted", eventId });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    server.log.error(error);
    if (errorMessage.includes("Cannot wake a Mind")) {
      return reply.code(409).send({ error: errorMessage });
    }
    return reply.code(500).send({ error: errorMessage });
  }
});

server.post("/executions/:executionId/started", async (request, reply) => {
  try {
    const { executionId } = request.params as { executionId: string };
    const callbackSecret = request.headers["x-minds-callback-secret"];

    if (callbackSecret !== MINDS_CALLBACK_SECRET) {
      return reply.code(401).send({ error: "Invalid callback secret" });
    }

    const body = request.body as { taskId?: unknown; workflowRunId?: unknown };
    const { taskId, workflowRunId } = body;

    if (typeof taskId !== "string" || !taskId || typeof workflowRunId !== "number" ||
        !Number.isSafeInteger(workflowRunId) || workflowRunId <= 0) {
      return reply.code(400).send({ error: "Missing taskId or workflowRunId" });
    }

    await mindRuntime.registerWorkflowRunId({ executionId, taskId, workflowRunId });

    return reply.code(200).send({ message: "Run ID registered" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    server.log.error(error);
    return reply.code(500).send({ error: message });
  }
});

server.post("/executions/:executionId/result", async (request, reply) => {
  try {
    const { executionId } = request.params as { executionId: string };
    const callbackSecret = request.headers["x-minds-callback-secret"];
    
    if (callbackSecret !== MINDS_CALLBACK_SECRET) {
      return reply.code(401).send({ error: "Invalid callback secret" });
    }

    if (!isRecord(request.body)) {
      return reply.code(400).send({ error: "Invalid callback body" });
    }
    const { taskId, status, result, error } = request.body;

    if (typeof taskId !== "string" || !taskId || (status !== "completed" && status !== "failed")) {
      return reply.code(400).send({ error: "Missing taskId or invalid status" });
    }

    if (status === "completed" && (typeof result !== "string" || !result)) {
      return reply.code(400).send({ error: "Completed status requires a result" });
    }
    if (error !== undefined && typeof error !== "string") {
      return reply.code(400).send({ error: "Error must be a string" });
    }

    await mindRuntime.recordExecutionResult({
      executionId,
      taskId,
      status,
      result: typeof result === "string" ? result : undefined,
      error: typeof error === "string" ? error : undefined,
    });

    return reply.code(200).send({ message: "Result recorded" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    server.log.error(error);
    return reply.code(500).send({ error: message });
  }
});

server.post("/executions/:executionId/approval", async (request, reply) => {
  try {
    const { executionId } = request.params as { executionId: string };
    const callbackSecret = request.headers["x-minds-callback-secret"];
    if (callbackSecret !== MINDS_CALLBACK_SECRET) {
      return reply.code(401).send({ error: "Invalid callback secret" });
    }

    if (!isRecord(request.body)) {
      return reply.code(400).send({ error: "Invalid callback body" });
    }
    const { taskId, approvalPayload } = request.body;
    if (typeof taskId !== "string" || !taskId || !isRecord(approvalPayload)) {
      return reply.code(400).send({ error: "Missing taskId or approvalPayload" });
    }

    await mindRuntime.requestApproval({ executionId, taskId, approvalPayload });
    return reply.code(200).send({ message: "Approval requested", taskId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    server.log.error(error);
    if (message.includes("does not belong")) {
      return reply.code(404).send({ error: "Execution or task not found" });
    }
    if (message.includes("status") || message.includes("approval") || message.includes("working")) {
      return reply.code(409).send({ error: message });
    }
    return reply.code(500).send({ error: message });
  }
});

server.get("/minds", async () => {
  const result = await query("SELECT * FROM minds");
  return result.rows;
});

server.get("/minds/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const result = await query("SELECT * FROM minds WHERE id = $1", [id]);
  
  if (result.rows.length === 0) {
    return reply.code(404).send({ error: "Mind not found" });
  }
  
  return result.rows[0];
});

server.get("/tasks", async () => {
  const result = await query("SELECT * FROM tasks ORDER BY created_at DESC");
  return result.rows;
});

server.get("/tasks/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const result = await query("SELECT * FROM tasks WHERE id = $1", [id]);

  if (result.rows.length === 0) {
    return reply.code(404).send({ error: "Task not found" });
  }

  return result.rows[0];
});

server.post("/tasks/:id/approve", async (request, reply) => {
  try {
    const { id } = request.params as { id: string };

    await mindRuntime.approveTask(id);

    return reply.code(200).send({ message: "Task approved", taskId: id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    server.log.error(error);
    if (message.includes("not found") || message.includes("not belong")) {
      return reply.code(404).send({ error: "Task not found" });
    }
    if (
      message.includes("status") ||
      message.includes("waiting") ||
      message.includes("approval") ||
      message.includes("working")
    ) {
      return reply.code(409).send({ error: message });
    }
    return reply.code(500).send({ error: message });
  }
});

server.post("/tasks/:id/reject", async (request, reply) => {
  try {
    const { id } = request.params as { id: string };

    await mindRuntime.rejectTask(id);

    return reply.code(200).send({ message: "Task rejected", taskId: id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    server.log.error(error);
    if (message.includes("not found") || message.includes("not belong")) {
      return reply.code(404).send({ error: "Task not found" });
    }
    if (
      message.includes("status") ||
      message.includes("waiting") ||
      message.includes("approval") ||
      message.includes("working")
    ) {
      return reply.code(409).send({ error: message });
    }
    return reply.code(500).send({ error: message });
  }
});

server.get("/health", async () => {
  return { status: "ok", timestamp: new Date().toISOString() };
});

async function start() {
  try {
    await initializeRuntime();
    
    const port = parseInt(process.env.PORT || "3000");
    await server.listen({ port, host: "0.0.0.0" });
    console.log(`Server running on port ${port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

const shutdown = async (signal: string) => {
  console.log(`Received ${signal}, shutting down...`);
  await mindRuntime.stopPolling();
  await server.close();
  await closePool();
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

start();

export { server, mindRuntime };