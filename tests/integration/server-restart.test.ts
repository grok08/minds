import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createTcpServer } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, expect, test } from "bun:test";
import { closePool, query } from "../../packages/db/src/client.ts";

const TEST_MIND_ID = `test-server-restart-${randomUUID()}`;
const TEST_EVENT_ID = `test-server-restart-event-${randomUUID()}`;
const TEST_TASK_ID = `test-server-restart-task-${randomUUID()}`;
const TEST_EXECUTION_ID = `test-server-restart-execution-${randomUUID()}`;

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

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
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

    const mindResponse = await fetch(`http://127.0.0.1:${port}/minds/${TEST_MIND_ID}`);
    expect(mindResponse.status).toBe(200);

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
      await stopServer(serverProcess);
    }
    await cleanTestMind();
  }
}, 30000);