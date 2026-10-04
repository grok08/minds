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

  test("registers a workflow run ID only for the matching execution and task", async () => {
    const eventId = generateId("test-run-id-registration");
    runtime = new PersistentMindRuntime(TEST_MIND_ID, {
      start: async (_task, execution) => execution,
      status: async (execution) => execution.status,
      stop: async () => {},
    });
    await runtime.initialize();
    await runtime.handleEvent({ id: eventId, type: "github.ci.failed", payload: "{}" });

    const runningSnapshot = await runtime.snapshot();
    const task = runningSnapshot.tasks[0];
    const execution = runningSnapshot.executions[0];

    await runtime.registerWorkflowRunId({
      executionId: execution.id,
      taskId: task.id,
      workflowRunId: 12345,
    });

    const registeredSnapshot = await runtime.snapshot();
    expect(registeredSnapshot.executions[0].workflowRunId).toBe(12345);
    await expect(runtime.registerWorkflowRunId({
      executionId: execution.id,
      taskId: generateId("wrong-task"),
      workflowRunId: 67890,
    })).rejects.toThrow("Execution does not belong to the task and Mind");
  });

  test("fails an execution that never registers a workflow run ID", async () => {
    const eventId = generateId("test-missing-run-id");
    runtime = new PersistentMindRuntime(TEST_MIND_ID, {
      start: async (_task, execution) => execution,
      status: async (execution) => execution.status,
      stop: async () => {},
    }, { timeoutMs: 60000, callbackGracePeriodMs: 1000 });
    await runtime.initialize();
    await runtime.handleEvent({ id: eventId, type: "github.ci.failed", payload: "{}" });

    const runningSnapshot = await runtime.snapshot();
    const execution = runningSnapshot.executions[0];
    await query("UPDATE executions SET started_at = $1 WHERE id = $2", [new Date(Date.now() - 2000), execution.id]);
    await runtime.pollExecutions();

    const failedSnapshot = await runtime.snapshot();
    expect(failedSnapshot.executions[0].status).toBe("failed");
    expect(failedSnapshot.executions[0].error).toContain("did not register run ID");
    expect(failedSnapshot.tasks[0].status).toBe("failed");
    expect(failedSnapshot.mind.state).toBe("sleeping");
  });

  test("fails a completed workflow that has no worker result", async () => {
    const eventId = generateId("test-missing-worker-result");
    runtime = new PersistentMindRuntime(TEST_MIND_ID, {
      start: async (_task, execution) => ({ ...execution, workflowRunId: 12345 }),
      status: async () => "completed",
      stop: async () => {},
    });
    await runtime.initialize();
    await runtime.handleEvent({ id: eventId, type: "github.ci.failed", payload: "{}" });

    await runtime.pollExecutions();

    const failedSnapshot = await runtime.snapshot();
    expect(failedSnapshot.executions[0].status).toBe("failed");
    expect(failedSnapshot.executions[0].error).toBe("Workflow completed but worker result not recorded");
    expect(failedSnapshot.tasks[0].status).toBe("failed");
    expect(failedSnapshot.mind.state).toBe("sleeping");
  });

  test("times out executions even when no workflow run ID was registered", async () => {
    const eventId = generateId("test-timeout-without-run-id");
    let stopCalled = false;
    runtime = new PersistentMindRuntime(TEST_MIND_ID, {
      start: async (_task, execution) => execution,
      status: async (execution) => execution.status,
      stop: async () => { stopCalled = true; },
    }, { timeoutMs: 1000, callbackGracePeriodMs: 60000 });
    await runtime.initialize();
    await runtime.handleEvent({ id: eventId, type: "github.ci.failed", payload: "{}" });

    const runningSnapshot = await runtime.snapshot();
    const execution = runningSnapshot.executions[0];
    await query("UPDATE executions SET started_at = $1 WHERE id = $2", [new Date(Date.now() - 5000), execution.id]);
    await runtime.pollExecutions();

    const failedSnapshot = await runtime.snapshot();
    expect(stopCalled).toBe(false);
    expect(failedSnapshot.executions[0].status).toBe("failed");
    expect(failedSnapshot.executions[0].error).toContain("timed out");
    expect(failedSnapshot.tasks[0].status).toBe("failed");
  });

  test("polling is single-flight and stopPolling waits for the active poll", async () => {
    const eventId = generateId("test-poll-drain");
    let statusCallCount = 0;
    let signalStatusStarted: () => void = () => {};
    let releaseStatus: () => void = () => {};
    const statusStarted = new Promise<void>((resolve) => { signalStatusStarted = resolve; });
    const statusGate = new Promise<void>((resolve) => { releaseStatus = resolve; });
    runtime = new PersistentMindRuntime(TEST_MIND_ID, {
      start: async (_task, execution) => ({ ...execution, workflowRunId: 12345 }),
      status: async () => {
        statusCallCount++;
        signalStatusStarted();
        await statusGate;
        return "running";
      },
      stop: async () => {},
    }, { intervalMs: 1, timeoutMs: 60000 });
    await runtime.initialize();
    await runtime.handleEvent({ id: eventId, type: "github.ci.failed", payload: "{}" });

    runtime.startPolling();
    await statusStarted;
    await runtime.pollExecutions();
    expect(statusCallCount).toBe(1);

    let shutdownFinished = false;
    const shutdown = runtime.stopPolling().then(() => { shutdownFinished = true; });
    await Promise.resolve();
    expect(shutdownFinished).toBe(false);
    releaseStatus();
    await shutdown;
    expect(shutdownFinished).toBe(true);
  });

  test("keeps a callback result when it races with timeout recovery", async () => {
    const eventId = generateId("test-callback-timeout-race");
    let signalStopStarted: () => void = () => {};
    let releaseStop: () => void = () => {};
    const stopStarted = new Promise<void>((resolve) => { signalStopStarted = resolve; });
    const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
    runtime = new PersistentMindRuntime(TEST_MIND_ID, {
      start: async (_task, execution) => ({ ...execution, workflowRunId: 12345 }),
      status: async () => "running",
      stop: async () => {
        signalStopStarted();
        await stopGate;
      },
    }, { timeoutMs: 1000 });
    await runtime.initialize();
    await runtime.handleEvent({ id: eventId, type: "github.ci.failed", payload: "{}" });

    const runningSnapshot = await runtime.snapshot();
    const task = runningSnapshot.tasks[0];
    const execution = runningSnapshot.executions[0];
    await query("UPDATE executions SET started_at = $1 WHERE id = $2", [new Date(Date.now() - 5000), execution.id]);

    const poll = runtime.pollExecutions();
    await stopStarted;
    await runtime.recordExecutionResult({
      executionId: execution.id,
      taskId: task.id,
      status: "completed",
      result: "Callback won the timeout race",
    });
    releaseStop();
    await poll;

    const completedSnapshot = await runtime.snapshot();
    expect(completedSnapshot.executions[0].status).toBe("completed");
    expect(completedSnapshot.executions[0].result).toBe("Callback won the timeout race");
    expect(completedSnapshot.tasks[0].status).toBe("completed");
    expect(completedSnapshot.mind.state).toBe("sleeping");
  });

  test("pollExecutions processes terminal workflow status and idempotently records results", async () => {
    const eventId = generateId("test-poll-completed");
    let pollCallCount = 0;
    const executionResult = "Worker completed the CI investigation";
    runtime = new PersistentMindRuntime(TEST_MIND_ID, {
      start: async (_task, execution) => ({
        ...execution,
        workflowRunId: 12345,
        status: "running",
      }),
      status: async (_execution) => {
        pollCallCount++;
        if (pollCallCount === 1) return "running";
        return "completed";
      },
      stop: async () => {},
    }, { intervalMs: 100, timeoutMs: 5000 });
    await runtime.initialize();

    await runtime.handleEvent({
      id: eventId,
      type: "github.ci.failed",
      payload: JSON.stringify({ runId: 789, workflow: "CI" }),
    });

    const runningSnapshot = await runtime.snapshot();
    const runningTask = runningSnapshot.tasks[0];
    const runningExecution = runningSnapshot.executions[0];
    expect(runningTask.status).toBe("running");
    expect(runningExecution.status).toBe("running");

    // Simulate worker callback providing the result before polling picks it up
    await query(
      `UPDATE executions SET result = $1 WHERE id = $2`,
      [executionResult, runningExecution.id]
    );

    await runtime.pollExecutions();
    await runtime.pollExecutions();

    const completedSnapshot = await runtime.snapshot();
    expect(runtime.getMindState()).toBe("sleeping");
    expect(completedSnapshot.tasks[0].status).toBe("completed");
    expect(completedSnapshot.executions[0].status).toBe("completed");
    expect(completedSnapshot.tasks[0].result).toBe(executionResult);
    expect(completedSnapshot.executions[0].result).toBe(executionResult);

    await runtime.pollExecutions();
    const afterExtraPoll = await runtime.snapshot();
    expect(afterExtraPoll.tasks[0].status).toBe("completed");
  });

  test("pollExecutions handles failed workflow status", async () => {
    const eventId = generateId("test-poll-failed");
    let pollCallCount = 0;
    runtime = new PersistentMindRuntime(TEST_MIND_ID, {
      start: async (_task, execution) => ({
        ...execution,
        workflowRunId: 12345,
      }),
      status: async (_execution) => {
        pollCallCount++;
        if (pollCallCount === 1) return "running";
        return "failed";
      },
      stop: async () => {},
    }, { intervalMs: 100, timeoutMs: 5000 });
    await runtime.initialize();

    await runtime.handleEvent({
      id: eventId,
      type: "github.ci.failed",
      payload: JSON.stringify({ runId: 999, workflow: "CI" }),
    });

    const runningSnapshot = await runtime.snapshot();
    const runningTask = runningSnapshot.tasks[0];
    const runningExecution = runningSnapshot.executions[0];

    await runtime.pollExecutions();
    await runtime.pollExecutions();

    const failedSnapshot = await runtime.snapshot();
    expect(runtime.getMindState()).toBe("sleeping");
    expect(failedSnapshot.tasks[0].status).toBe("failed");
    expect(failedSnapshot.tasks[0].error).toBe("Workflow failed");
    expect(failedSnapshot.executions[0].status).toBe("failed");
    expect(failedSnapshot.executions[0].error).toBe("Workflow failed");

    await runtime.handleEvent({
      id: generateId("test-event-after-poll-failure"),
      type: "demo.requested",
      payload: "Continue after poll failure",
    });
    const nextSnapshot = await runtime.snapshot();
    expect(nextSnapshot.tasks.at(-1)?.status).toBe("running");
  });

  test("pollExecutions times out stuck execution and stops workflow", async () => {
    const eventId = generateId("test-poll-timeout");
    let stopCalled = false;
    runtime = new PersistentMindRuntime(TEST_MIND_ID, {
      start: async (_task, execution) => ({
        ...execution,
        workflowRunId: 12345,
      }),
      status: async () => "running",
      stop: async () => { stopCalled = true; },
    }, { intervalMs: 100, timeoutMs: 1000 });
    await runtime.initialize();

    await runtime.handleEvent({
      id: eventId,
      type: "github.ci.failed",
      payload: JSON.stringify({ runId: 111, workflow: "CI" }),
    });

    const runningSnapshot = await runtime.snapshot();
    const runningTask = runningSnapshot.tasks[0];
    const runningExecution = runningSnapshot.executions[0];
    expect(runningExecution.workflowRunId).toBe(12345);

    // Manually update startedAt to be old to simulate stuck execution
    await query(
      `UPDATE executions SET started_at = $1 WHERE id = $2`,
      [new Date(Date.now() - 60000), runningExecution.id]
    );

    await runtime.pollExecutions();

    const timedOutSnapshot = await runtime.snapshot();
    expect(stopCalled).toBe(true);
    expect(runtime.getMindState()).toBe("sleeping");
    expect(timedOutSnapshot.tasks[0].status).toBe("failed");
    expect(timedOutSnapshot.tasks[0].error).toContain("timed out");
    expect(timedOutSnapshot.executions[0].status).toBe("failed");
    expect(timedOutSnapshot.executions[0].error).toContain("timed out");
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