import Fastify from "fastify";
import { query, transaction, closePool } from "../../../packages/db/src/client.ts";
import { PersistentMindRuntime } from "../../../packages/runtime/src/runtime.ts";
import { createGitHubEventRouter, InvalidWebhookSignatureError } from "../../../packages/github/src/events.ts";
import { createGitHubWorkerProvider } from "../../../packages/providers/github-worker/provider.ts";
import { generateId, toRepository } from "../../../packages/runtime/src/domain/types.ts";

const server = Fastify({ logger: true });
const rawBodies = new WeakMap<object, Buffer>();

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

server.post("/executions/:executionId/result", async (request, reply) => {
  try {
    const { executionId } = request.params as { executionId: string };
    const callbackSecret = request.headers["x-minds-callback-secret"];
    
    if (callbackSecret !== MINDS_CALLBACK_SECRET) {
      return reply.code(401).send({ error: "Invalid callback secret" });
    }

    const body = request.body as { taskId: string; status: "completed" | "failed"; result?: string; error?: string };
    const { taskId, status, result, error } = body;

    if (!taskId || !status) {
      return reply.code(400).send({ error: "Missing taskId or status" });
    }

    const now = new Date();
    
    if (status === "completed") {
      await query(
        `UPDATE executions SET status = 'completed', result = $1, completed_at = $2 WHERE id = $3`,
        [result ?? "", now, executionId]
      );
      await query(
        `UPDATE tasks SET status = 'completed', result = $1, updated_at = $2 WHERE id = $3`,
        [result ?? "", now, taskId]
      );
    } else {
      await query(
        `UPDATE executions SET status = 'failed', error = $1, completed_at = $2 WHERE id = $3`,
        [error ?? "Worker failed", now, executionId]
      );
      await query(
        `UPDATE tasks SET status = 'failed', error = $1, updated_at = $2 WHERE id = $3`,
        [error ?? "Worker failed", now, taskId]
      );
    }

    const mindResult = await query("SELECT mind_id FROM tasks WHERE id = $1", [taskId]);
    if (mindResult.rows.length > 0) {
      const mindId = mindResult.rows[0].mind_id;
      await query(
        `UPDATE minds SET state = 'sleeping', updated_at = $1 WHERE id = $2`,
        [now, mindId]
      );
      await query(
        `INSERT INTO state_transitions (id, mind_id, from_state, to_state, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [generateId("transition"), mindId, "working", "sleeping", now]
      );
      await query(
        `UPDATE events SET processed = true WHERE id = (SELECT event_id FROM tasks WHERE id = $1)`,
        [taskId]
      );
    }

    return reply.code(200).send({ message: "Result recorded" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    server.log.error(error);
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
  const { id } = request.params as { id: string };
  
  const taskResult = await query("SELECT * FROM tasks WHERE id = $1", [id]);
  if (taskResult.rows.length === 0) {
    return reply.code(404).send({ error: "Task not found" });
  }
  
  const task = taskResult.rows[0];
  if (task.status !== "waiting") {
    return reply.code(400).send({ error: "Task is not waiting for approval" });
  }
  
  await query(
    `UPDATE tasks SET status = 'running', updated_at = $1 WHERE id = $2`,
    [new Date(), id]
  );
  
  await query(
    `INSERT INTO approvals (id, task_id, status, decided_at) VALUES ($1, $2, $3, $4)`,
    [generateId("approval"), id, "approved", new Date()]
  );
  
  return { message: "Task approved", taskId: id };
});

server.post("/tasks/:id/reject", async (request, reply) => {
  const { id } = request.params as { id: string };
  
  const taskResult = await query("SELECT * FROM tasks WHERE id = $1", [id]);
  if (taskResult.rows.length === 0) {
    return reply.code(404).send({ error: "Task not found" });
  }
  
  const task = taskResult.rows[0];
  if (task.status !== "waiting") {
    return reply.code(400).send({ error: "Task is not waiting for approval" });
  }
  
  await query(
    `UPDATE tasks SET status = 'failed', error = 'Rejected by human', updated_at = $1 WHERE id = $2`,
    [new Date(), id]
  );
  
  await query(
    `INSERT INTO approvals (id, task_id, status, decided_at) VALUES ($1, $2, $3, $4)`,
    [generateId("approval"), id, "rejected", new Date()]
  );
  
  return { message: "Task rejected", taskId: id };
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

start();

export { server, mindRuntime };