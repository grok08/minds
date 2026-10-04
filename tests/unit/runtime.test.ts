import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { PersistentMindRuntime } from "../../packages/runtime/src/runtime.ts";
import { createMockProvider } from "../../packages/providers/mock-provider.ts";
import { query, closePool } from "../../packages/db/src/client.ts";

const TEST_MIND_ID = "test-repository";

describe("PersistentMindRuntime", () => {
  let runtime: PersistentMindRuntime;

  afterAll(async () => {
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
    const eventId = "test-event-1";

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

  test("recovers state after restart", async () => {
    const eventId = "test-event-recovery";

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
    const interruptedEventId = "test-event-interrupted";
    const interruptedTaskId = "test-task-interrupted";
    const interruptedExecutionId = "test-execution-interrupted";
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

    const nextEventId = "test-event-after-recovery";
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
    const eventId = "test-idempotent-event";

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