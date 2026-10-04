import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createTcpServer } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, expect, test } from "bun:test";
import { closePool, query } from "../../packages/db/src/client.ts";
import { PersistentMindRuntime } from "../../packages/runtime/src/runtime.ts";
import { createMockProvider } from "../../packages/providers/mock-provider.ts";

const TEST_MIND_ID = `test-server-restart-${randomUUID()}`;
const TEST_EVENT_ID = `test-server-restart-event-${randomUUID()}`;
const TEST_TASK_ID = `test-server-restart-task-${randomUUID()}`;
const TEST_EXECUTION_ID = `test-server-restart-execution-${randomUUID()}`;
const CALLBACK_EVENT_ID = `test-callback-event-${randomUUID()}`;
const CALLBACK_TASK_ID = `test-callback-task-${randomUUID()}`;
const CALLBACK_EXECUTION_ID = `test-callback-execution-${randomUUID()}`;

afterAll(async () => {
  await closePool();
});

async function getAvailablePort(): Promise<number> {
  const listener = createTcpServer();
  return new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not determine an available test port"));
        return;
      }
      listener.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function startServer(port: number): ChildProcess {
  const env: NodeJS.ProcessEnv = {
    PORT: String(port),
    MIND_ID: TEST_MIND_ID,
    GITHUB_WEBHOOK_SECRET: "server-restart-test-secret",
    GITHUB_OWNER: "server-restart-test-owner",
    GITHUB_REPO: "server-restart-test-repo",
    MINDS_CALLBACK_SECRET: "test-callback-secret",
    MINDS_SERVER_URL: `http://127.0.0.1:${port}`,
    GITHUB_TOKEN: "test-token",
  };

  for (const key of ["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD"]) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  return spawn(process.execPath, ["apps/server/src/server.ts"], {
    cwd: process.cwd(),
    env,
    stdio: "ignore",
  });
}

async function waitForServer(child: ChildProcess, port: number): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited before becoming healthy with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) {
        return;
      }
    } catch {
      await Bun.sleep(50);
    }
  }
  throw new Error("Server did not become healthy within 15 seconds");
}

async function stopServer(child: ChildProcess, signal: "SIGKILL" | "SIGTERM" = "SIGKILL"): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill(signal);
  await exited;
}

async function cleanTestMind(): Promise<void> {
  await query("DELETE FROM state_transitions WHERE mind_id = $1", [TEST_MIND_ID]);
  await query("DELETE FROM executions WHERE task_id = $1", [TEST_TASK_ID]);
  await query("DELETE FROM tasks WHERE mind_id = $1", [TEST_MIND_ID]);
  await query("DELETE FROM events WHERE mind_id = $1", [TEST_MIND_ID]);
  await query("DELETE FROM minds WHERE id = $1", [TEST_MIND_ID]);
}

test("server restart recovers persisted running work", async () => {
  const port = await getAvailablePort();
  let serverProcess: ChildProcess | undefined;

  try {
    serverProcess = startServer(port);
    await waitForServer(serverProcess, port);

    const memoryRuntime = new PersistentMindRuntime(TEST_MIND_ID, createMockProvider());
    await memoryRuntime.initialize();
    await memoryRuntime.remember("fact", {
      statement: "This memory must remain after the server restarts.",
    });

    const mindResponse = await fetch(`http://127.0.0.1:${port}/minds/${TEST_MIND_ID}`);
    expect(mindResponse.status).toBe(200);

    const callbackStartedAt = new Date();
    await query(
      `INSERT INTO events (id, type, mind_id, payload, processed, created_at)
       VALUES ($1, $2, $3, $4, false, $5)`,
      [CALLBACK_EVENT_ID, "github.ci.failed", TEST_MIND_ID, JSON.stringify({ text: "{}" }), callbackStartedAt]
    );
    await query(
      `INSERT INTO tasks (id, mind_id, type, description, status, event_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'running', $5, $6, $6)`,
      [CALLBACK_TASK_ID, TEST_MIND_ID, "github.ci.failed", "Callback test", CALLBACK_EVENT_ID, callbackStartedAt]
    );
    await query(
      `INSERT INTO executions (id, task_id, provider, status, started_at)
       VALUES ($1, $2, 'github-worker', 'running', $3)`,
      [CALLBACK_EXECUTION_ID, CALLBACK_TASK_ID, callbackStartedAt]
    );
    await query("UPDATE minds SET state = 'working' WHERE id = $1", [TEST_MIND_ID]);

    const invalidRegistration = await fetch(
      `http://127.0.0.1:${port}/executions/${CALLBACK_EXECUTION_ID}/started`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Minds-Callback-Secret": "test-callback-secret",
        },
        body: JSON.stringify({ taskId: CALLBACK_TASK_ID, workflowRunId: "not-a-number" }),
      }
    );
    expect(invalidRegistration.status).toBe(400);

    const registration = await fetch(
      `http://127.0.0.1:${port}/executions/${CALLBACK_EXECUTION_ID}/started`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Minds-Callback-Secret": "test-callback-secret",
        },
        body: JSON.stringify({ taskId: CALLBACK_TASK_ID, workflowRunId: 123456 }),
      }
    );
    expect(registration.status).toBe(200);
    const registeredRun = await query<{ workflow_run_id: string | number }>(
      "SELECT workflow_run_id FROM executions WHERE id = $1",
      [CALLBACK_EXECUTION_ID]
    );
    expect(Number(registeredRun.rows[0].workflow_run_id)).toBe(123456);

    const failureCallback = await fetch(
      `http://127.0.0.1:${port}/executions/${CALLBACK_EXECUTION_ID}/result`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Minds-Callback-Secret": "test-callback-secret",
        },
        body: JSON.stringify({
          taskId: CALLBACK_TASK_ID,
          status: "failed",
          error: "Worker failure callback test",
        }),
      }
    );
    expect(failureCallback.status).toBe(200);
    const callbackOutcome = await query<{
      task_status: string;
      task_error: string;
      execution_status: string;
      execution_error: string;
      event_processed: boolean;
      mind_state: string;
    }>(
      `SELECT t.status AS task_status, t.error AS task_error,
              e.status AS execution_status, e.error AS execution_error,
              v.processed AS event_processed, m.state AS mind_state
       FROM tasks t
       JOIN executions e ON e.task_id = t.id
       JOIN events v ON v.id = t.event_id
       JOIN minds m ON m.id = t.mind_id
       WHERE t.id = $1`,
      [CALLBACK_TASK_ID]
    );
    expect(callbackOutcome.rows[0]).toEqual({
      task_status: "failed",
      task_error: "Worker failure callback test",
      execution_status: "failed",
      execution_error: "Worker failure callback test",
      event_processed: true,
      mind_state: "sleeping",
    });

    const startedAt = new Date();
    await query(
      `INSERT INTO events (id, type, mind_id, payload, processed, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [TEST_EVENT_ID, "demo.requested", TEST_MIND_ID, JSON.stringify({ text: "Interrupted" }), false, startedAt]
    );
    await query(
      `INSERT INTO tasks (id, mind_id, type, description, status, event_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [TEST_TASK_ID, TEST_MIND_ID, "demo.requested", "Interrupted task", "running", TEST_EVENT_ID, startedAt, startedAt]
    );
    await query(
      `INSERT INTO executions (id, task_id, provider, status, started_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [TEST_EXECUTION_ID, TEST_TASK_ID, "github-worker", "running", startedAt]
    );
    await query("UPDATE minds SET state = 'working' WHERE id = $1", [TEST_MIND_ID]);

    await stopServer(serverProcess);
    serverProcess = undefined;

    serverProcess = startServer(port);
    await waitForServer(serverProcess, port);

    const recoveredMindResponse = await fetch(`http://127.0.0.1:${port}/minds/${TEST_MIND_ID}`);
    expect(recoveredMindResponse.status).toBe(200);
    const recoveredMind = await recoveredMindResponse.json();
    expect(recoveredMind.state).toBe("sleeping");

    const restartedMemoryRuntime = new PersistentMindRuntime(TEST_MIND_ID, createMockProvider());
    await restartedMemoryRuntime.initialize();
    const restartedMemory = await restartedMemoryRuntime.getMemory();
    expect(restartedMemory).toContainEqual(expect.objectContaining({
      type: "fact",
      content: { statement: "This memory must remain after the server restarts." },
    }));

    const recoveredTaskResponse = await fetch(`http://127.0.0.1:${port}/tasks/${TEST_TASK_ID}`);
    expect(recoveredTaskResponse.status).toBe(200);
    const recoveredTask = await recoveredTaskResponse.json();
    expect(recoveredTask.status).toBe("failed");
    expect(recoveredTask.error).toBe("Task interrupted by runtime restart");

    const executionResult = await query<{ status: string; error: string }>(
      "SELECT status, error FROM executions WHERE id = $1",
      [TEST_EXECUTION_ID]
    );
    expect(executionResult.rows[0].status).toBe("failed");
    expect(executionResult.rows[0].error).toBe("Execution interrupted by restart");

    const eventResult = await query<{ processed: boolean }>(
      "SELECT processed FROM events WHERE id = $1",
      [TEST_EVENT_ID]
    );
    expect(eventResult.rows[0].processed).toBe(true);
  } finally {
    if (serverProcess) {
      await stopServer(serverProcess, "SIGTERM");
    }
    await cleanTestMind();
  }
}, 30000);