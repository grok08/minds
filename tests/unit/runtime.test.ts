import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { PersistentMindRuntime } from "../../packages/runtime/src/runtime.ts";
import { generateId } from "../../packages/runtime/src/domain/types.ts";
import { createMockProvider } from "../../packages/providers/mock-provider.ts";
import { query, closePool } from "../../packages/db/src/client.ts";

const TEST_MIND_ID = `test-repository-${randomUUID()}`;

describe("PersistentMindRuntime", () => {
  let runtime: PersistentMindRuntime;

  afterAll(async () => {
    await query("DELETE FROM state_transitions WHERE mind_id = $1", [TEST_MIND_ID]);
    await query("DELETE FROM executions WHERE task_id IN (SELECT id FROM tasks WHERE mind_id = $1)", [TEST_MIND_ID]);
    await query("DELETE FROM tasks WHERE mind_id = $1", [TEST_MIND_ID]);
    await query("DELETE FROM events WHERE mind_id = $1", [TEST_MIND_ID]);
    await query("DELETE FROM minds WHERE id = $1", [TEST_MIND_ID]);
    await closePool();
  });

  beforeEach(async () => {
    await query("DELETE FROM state_transitions WHERE mind_id = $1", [TEST_MIND_ID]);
    await query("DELETE FROM executions WHERE task_id IN (SELECT id FROM tasks WHERE mind_id = $1)", [TEST_MIND_ID]);
    await query("DELETE FROM tasks WHERE mind_id = $1", [TEST_MIND_ID]);
    await query("DELETE FROM events WHERE mind_id = $1", [TEST_MIND_ID]);
    await query("DELETE FROM minds WHERE id = $1", [TEST_MIND_ID]);
    
    runtime = new PersistentMindRuntime(TEST_MIND_ID, createMockProvider());
    await runtime.initialize();
  });

  test("wakes for an event, records the result, and returns to sleep", async () => {
    const eventId = generateId("test-event");

    await runtime.handleEvent({
      id: eventId,
      type: "demo.requested",
      payload: "Run the lifecycle",
    });

    const snapshot = await runtime.snapshot();

    expect(snapshot.mind.id).toBe(TEST_MIND_ID);
    expect(snapshot.mind.state).toBe("sleeping");
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.events[0].id).toBe(eventId);
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0].status).toBe("completed");
    expect(snapshot.executions).toHaveLength(1);
    expect(snapshot.executions[0].status).toBe("completed");
  });

  test("records a worker result once and synchronizes runtime state", async () => {
    const eventId = generateId("test-worker-callback");
    runtime = new PersistentMindRuntime(TEST_MIND_ID, {
      start: async (_task, execution) => execution,
      status: async (execution) => execution.status,
      stop: async () => {},
    });
    await runtime.initialize();

    await runtime.handleEvent({
      id: eventId,
      type: "github.ci.failed",
      payload: JSON.stringify({ runId: 123, workflow: "CI" }),
    });

    const runningSnapshot = await runtime.snapshot();
    const runningTask = runningSnapshot.tasks[0];
    const runningExecution = runningSnapshot.executions[0];

    expect(runtime.getMindState()).toBe("working");
    expect(runningTask.status).toBe("running");
    expect(runningExecution.status).toBe("running");

    await runtime.recordExecutionResult({
      executionId: runningExecution.id,
      taskId: runningTask.id,
      status: "completed",
      result: "Worker completed the CI investigation",
    });
    await runtime.recordExecutionResult({
      executionId: runningExecution.id,
      taskId: runningTask.id,
      status: "completed",
      result: "Worker completed the CI investigation",
    });

    const completedSnapshot = await runtime.snapshot();
    const completedTask = completedSnapshot.tasks[0];
    const completedExecution = completedSnapshot.executions[0];
    const event = await query<{ processed: boolean }>(
      "SELECT processed FROM events WHERE id = $1",
      [eventId]
    );

    expect(runtime.getMindState()).toBe("sleeping");
    expect(completedSnapshot.mind.state).toBe("sleeping");
    expect(completedTask.status).toBe("completed");
    expect(completedTask.result).toBe("Worker completed the CI investigation");
    expect(completedExecution.status).toBe("completed");
    expect(completedExecution.result).toBe("Worker completed the CI investigation");
    expect(event.rows[0].processed).toBe(true);
  });

  test("records a failed worker result and leaves the Mind able to accept another event", async () => {
    const eventId = generateId("test-worker-failure-callback");
    runtime = new PersistentMindRuntime(TEST_MIND_ID, {
      start: async (_task, execution) => execution,
      status: async (execution) => execution.status,
      stop: async () => {},
    });
    await runtime.initialize();

    await runtime.handleEvent({
      id: eventId,
      type: "github.ci.failed",
      payload: JSON.stringify({ runId: 456, workflow: "CI" }),
    });

    const runningSnapshot = await runtime.snapshot();
    const runningTask = runningSnapshot.tasks[0];
    const runningExecution = runningSnapshot.executions[0];

    await runtime.recordExecutionResult({
      executionId: runningExecution.id,
      taskId: runningTask.id,
      status: "failed",
      error: "Worker process exited unsuccessfully",
    });

    const failedSnapshot = await runtime.snapshot();
    expect(runtime.getMindState()).toBe("sleeping");
    expect(failedSnapshot.tasks[0].status).toBe("failed");
    expect(failedSnapshot.tasks[0].error).toBe("Worker process exited unsuccessfully");
    expect(failedSnapshot.executions[0].status).toBe("failed");
    expect(failedSnapshot.executions[0].error).toBe("Worker process exited unsuccessfully");

    await runtime.handleEvent({
      id: generateId("test-event-after-worker-failure"),
      type: "demo.requested",
      payload: "Continue after worker failure",
    });

    const nextSnapshot = await runtime.snapshot();
    expect(nextSnapshot.tasks.at(-1)?.status).toBe("running");
    expect(runtime.getMindState()).toBe("working");
  });

  test("recovers state after restart", async () => {
    const eventId = generateId("test-event-recovery");

    await runtime.handleEvent({
      id: eventId,
      type: "demo.requested",
      payload: "Test recovery",
    });

    const snapshotBeforeRestart = await runtime.snapshot();
    const taskId = snapshotBeforeRestart.tasks[0].id;

    runtime = new PersistentMindRuntime(TEST_MIND_ID, createMockProvider());
    await runtime.initialize();

    const snapshotAfterRestart = await runtime.snapshot();

    expect(snapshotAfterRestart.mind.id).toBe(TEST_MIND_ID);
    expect(snapshotAfterRestart.mind.state).toBe("sleeping");
    expect(snapshotAfterRestart.tasks.some((t) => t.id === taskId && t.status === "completed")).toBe(true);
  });

  test("fails interrupted work, returns to sleep, and accepts a new event after restart", async () => {
    const interruptedEventId = generateId("test-event-interrupted");
    const interruptedTaskId = generateId("test-task-interrupted");
    const interruptedExecutionId = generateId("test-execution-interrupted");
    const startedAt = new Date();

    await query(
      `INSERT INTO events (id, type, mind_id, payload, processed, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [interruptedEventId, "demo.requested", TEST_MIND_ID, JSON.stringify({ text: "Interrupted" }), false, startedAt]
    );
    await query(
      `INSERT INTO tasks (id, mind_id, type, description, status, event_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [interruptedTaskId, TEST_MIND_ID, "demo.requested", "Interrupted task", "running", interruptedEventId, startedAt, startedAt]
    );
    await query(
      `INSERT INTO executions (id, task_id, provider, status, started_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [interruptedExecutionId, interruptedTaskId, "github-worker", "running", startedAt]
    );
    await query("UPDATE minds SET state = 'working' WHERE id = $1", [TEST_MIND_ID]);

    runtime = new PersistentMindRuntime(TEST_MIND_ID, createMockProvider());
    await runtime.initialize();

    const recoveredSnapshot = await runtime.snapshot();
    const recoveredTask = recoveredSnapshot.tasks.find((task) => task.id === interruptedTaskId);
    const recoveredExecution = recoveredSnapshot.executions.find((execution) => execution.id === interruptedExecutionId);

    expect(recoveredSnapshot.mind.state).toBe("sleeping");
    expect(recoveredTask?.status).toBe("failed");
    expect(recoveredTask?.error).toBe("Task interrupted by runtime restart");
    expect(recoveredExecution?.status).toBe("failed");
    expect(recoveredExecution?.error).toBe("Execution interrupted by restart");
    const recoveredEvent = await query<{ processed: boolean }>(
      "SELECT processed FROM events WHERE id = $1",
      [interruptedEventId]
    );
    expect(recoveredEvent.rows[0].processed).toBe(true);

    const nextEventId = generateId("test-event-after-recovery");
    await runtime.handleEvent({
      id: nextEventId,
      type: "demo.requested",
      payload: "Run after recovery",
    });

    const snapshotAfterNewEvent = await runtime.snapshot();
    expect(snapshotAfterNewEvent.mind.state).toBe("sleeping");
    expect(snapshotAfterNewEvent.tasks.find((task) => task.eventId === nextEventId)?.status).toBe("completed");
  });

  test("idempotency: duplicate event is ignored", async () => {
    const eventId = generateId("test-idempotent-event");

    await runtime.handleEvent({
      id: eventId,
      type: "demo.requested",
      payload: "Test idempotency",
    });

    await runtime.handleEvent({
      id: eventId,
      type: "demo.requested",
      payload: "Test idempotency",
    });

    const snapshot = await runtime.snapshot();

    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.executions).toHaveLength(1);
  });
});