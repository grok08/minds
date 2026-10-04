import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { PersistentMindRuntime } from "../../packages/runtime/src/runtime.ts";
import { generateId } from "../../packages/runtime/src/domain/types.ts";
import { createMockProvider } from "../../packages/providers/mock-provider.ts";
import { query, closePool } from "../../packages/db/src/client.ts";
import type { MemoryContextEntry } from "../../packages/memory/src/types.ts";

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

  test("fails a synchronous execution without a result and records its outcome", async () => {
    runtime = new PersistentMindRuntime(TEST_MIND_ID, {
      start: async (_task, execution) => ({
        ...execution,
        status: "completed",
        result: "",
      }),
      status: async (execution) => execution.status,
      stop: async () => {},
    });
    await runtime.initialize();

    await runtime.handleEvent({
      id: generateId("test-empty-result"),
      type: "demo.requested",
      payload: "Return an empty result",
    });

    const snapshot = await runtime.snapshot();
    expect(snapshot.tasks[0].status).toBe("failed");
    expect(snapshot.tasks[0].error).toBe("Worker completed without a result");
    expect(runtime.getMindState()).toBe("failed");
    expect((await runtime.getMemory()).find((entry) => entry.type === "task_outcome")?.content)
      .toEqual({
        taskId: snapshot.tasks[0].id,
        status: "failed",
        error: "Worker completed without a result",
      });
  });

  test("stores Mind memory, sends it to the worker, and reloads it after runtime restart", async () => {
    let receivedMemory: MemoryContextEntry[] = [];
    runtime = new PersistentMindRuntime(TEST_MIND_ID, {
      start: async (_task, execution, memoryContext) => {
        receivedMemory = memoryContext;
        execution.status = "completed";
        execution.result = "Completed with Mind memory";
        return execution;
      },
      status: async (execution) => execution.status,
      stop: async () => {},
    });
    await runtime.initialize();

    await runtime.remember("fact", { statement: "The repository uses Bun." });
    await runtime.handleEvent({
      id: generateId("test-memory-context"),
      type: "demo.requested",
      payload: "Use stored repository knowledge",
    });

    expect(receivedMemory).toEqual([{
      type: "fact",
      content: { statement: "The repository uses Bun." },
    }]);

    const persistedMemory = await runtime.getMemory();
    expect(persistedMemory).toHaveLength(2);
    expect(persistedMemory[1].type).toBe("task_outcome");
    expect(persistedMemory[1].content.status).toBe("completed");

    const restartedRuntime = new PersistentMindRuntime(TEST_MIND_ID, createMockProvider());
    await restartedRuntime.initialize();
    expect(await restartedRuntime.getMemory()).toEqual(persistedMemory);
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

    const outcomes = (await runtime.getMemory()).filter((entry) => entry.type === "task_outcome");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].content).toEqual({
      taskId: runningTask.id,
      status: "completed",
      result: "Worker completed the CI investigation",
    });
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
    expect((await runtime.getMemory()).filter((entry) => entry.type === "task_outcome")[0].content)
      .toEqual({
        taskId: runningTask.id,
        status: "failed",
        error: "Worker process exited unsuccessfully",
      });

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

  test("requestApproval moves task to waiting and records approval payload", async () => {
    const eventId = generateId("test-approval-request");
    runtime = new PersistentMindRuntime(TEST_MIND_ID, {
      start: async (_task, execution) => ({
        ...execution,
        workflowRunId: 12345,
        status: "running",
      }),
      status: async () => "running",
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

    expect(runningTask.status).toBe("running");
    expect(runningExecution.status).toBe("running");

    // Request approval with payload
    await runtime.requestApproval({
      executionId: runningExecution.id,
      taskId: runningTask.id,
      approvalPayload: { fix: "fix the bug", pr: 123 },
    });

    const waitingSnapshot = await runtime.snapshot();
    expect(runtime.getMindState()).toBe("waiting");
    expect(waitingSnapshot.mind.state).toBe("waiting");
    expect(waitingSnapshot.tasks[0].status).toBe("waiting");
    expect(waitingSnapshot.tasks[0].approvalPayload).toEqual({ fix: "fix the bug", pr: 123 });
    expect(waitingSnapshot.tasks[0].approvalRequestedAt).toBeDefined();
    expect(waitingSnapshot.executions[0].status).toBe("completed");

    // Approval record should exist
    const approvals = await query("SELECT * FROM approvals WHERE task_id = $1", [runningTask.id]);
    expect(approvals.rows.length).toBe(1);
    expect(approvals.rows[0].status).toBe("pending");
    expect(approvals.rows[0].continuation_data).toEqual({ fix: "fix the bug", pr: 123 });

    // Event should be processed
    const event = await query<{ processed: boolean }>(
      "SELECT processed FROM events WHERE id = $1",
      [eventId]
    );
    expect(event.rows[0].processed).toBe(true);
  });

  test("approveTask resumes task with new execution and preserves approval payload", async () => {
    const eventId = generateId("test-approval-resume");
    const continuationResult = "Resumed after approval";
    let startCallCount = 0;
    runtime = new PersistentMindRuntime(TEST_MIND_ID, {
      start: async (_task, execution) => {
        startCallCount++;
        if (startCallCount === 2) {
          await runtime.recordExecutionResult({
            executionId: execution.id,
            taskId: execution.taskId,
            status: "completed",
            result: continuationResult,
          });
        }
        return {
          ...execution,
          workflowRunId: 12345 + startCallCount,
          status: "running",
        };
      },
      status: async () => "running",
      stop: async () => {},
    }, { intervalMs: 100, timeoutMs: 5000 });
    await runtime.initialize();

    await runtime.handleEvent({
      id: eventId,
      type: "github.ci.failed",
      payload: JSON.stringify({ runId: 111, workflow: "CI" }),
    });

    const runningSnapshot = await runtime.snapshot();
    const runningTask = runningSnapshot.tasks[0];
    const runningExecution = runningSnapshot.executions[0];

    await runtime.requestApproval({
      executionId: runningExecution.id,
      taskId: runningTask.id,
      approvalPayload: { fix: "fix the bug" },
    });

    // Approve the task
    await runtime.approveTask(runningTask.id);

    // Poll to complete the resumed execution
    await runtime.pollExecutions();
    await runtime.pollExecutions();

    const completedSnapshot = await runtime.snapshot();
    expect(runtime.getMindState()).toBe("sleeping");
    expect(completedSnapshot.tasks[0].status).toBe("completed");
    expect(completedSnapshot.tasks[0].result).toBe(continuationResult);
    expect(completedSnapshot.executions[0].status).toBe("completed");
    expect(completedSnapshot.executions[0].result).toContain("Approval requested:");

    // Should have two executions (original + resumed)
    expect(completedSnapshot.executions.length).toBe(2);
    // The worker finished after it requested approval.
    expect(completedSnapshot.executions[0].status).toBe("completed");
    expect(completedSnapshot.executions[0].result).toContain("Approval requested:");
    // Second execution should be completed
    expect(completedSnapshot.executions[1].status).toBe("completed");
    expect(completedSnapshot.executions[1].result).toBe(continuationResult);

    // Approval record should be updated
    const approvals = await query("SELECT * FROM approvals WHERE task_id = $1", [runningTask.id]);
    expect(approvals.rows[0].status).toBe("approved");
    expect(approvals.rows[0].decision).toBe("approved");
    expect(approvals.rows[0].decided_at).toBeDefined();

    // Event should be processed
    const event = await query<{ processed: boolean }>(
      "SELECT processed FROM events WHERE id = $1",
      [eventId]
    );
    expect(event.rows[0].processed).toBe(true);
  });

  test("rejectTask fails task and records rejection", async () => {
    const eventId = generateId("test-approval-reject");
    runtime = new PersistentMindRuntime(TEST_MIND_ID, {
      start: async (_task, execution) => ({
        ...execution,
        workflowRunId: 12345,
        status: "running",
      }),
      status: async () => "running",
      stop: async () => {},
    }, { intervalMs: 100, timeoutMs: 5000 });
    await runtime.initialize();

    await runtime.handleEvent({
      id: eventId,
      type: "github.ci.failed",
      payload: JSON.stringify({ runId: 222, workflow: "CI" }),
    });

    const runningSnapshot = await runtime.snapshot();
    const runningTask = runningSnapshot.tasks[0];
    const runningExecution = runningSnapshot.executions[0];

    await runtime.requestApproval({
      executionId: runningExecution.id,
      taskId: runningTask.id,
      approvalPayload: { fix: "risky fix" },
    });

    await runtime.rejectTask(runningTask.id);

    const rejectedSnapshot = await runtime.snapshot();
    expect(runtime.getMindState()).toBe("sleeping");
    expect(rejectedSnapshot.tasks[0].status).toBe("failed");
    expect(rejectedSnapshot.tasks[0].error).toBe("Rejected by human");
    expect(rejectedSnapshot.executions[0].status).toBe("completed");

    // Approval record should be updated
    const approvals = await query("SELECT * FROM approvals WHERE task_id = $1", [runningTask.id]);
    expect(approvals.rows[0].status).toBe("rejected");
    expect(approvals.rows[0].decision).toBe("rejected");
    expect(approvals.rows[0].decided_at).toBeDefined();

    const memoryOutcomes = (await runtime.getMemory())
      .filter((entry) => entry.type === "task_outcome");
    expect(memoryOutcomes).toHaveLength(1);
    expect(memoryOutcomes[0].content).toEqual({
      taskId: runningTask.id,
      status: "rejected",
      error: "Rejected by human",
    });

    // Event should be processed
    const event = await query<{ processed: boolean }>(
      "SELECT processed FROM events WHERE id = $1",
      [eventId]
    );
    expect(event.rows[0].processed).toBe(true);
  });

  test("approveTask and rejectTask reject invalid transitions", async () => {
    const eventId = generateId("test-approval-invalid-transition");
    runtime = new PersistentMindRuntime(TEST_MIND_ID, {
      start: async (_task, execution) => execution,
      status: async (execution) => execution.status,
      stop: async () => {},
    });
    await runtime.initialize();

    await runtime.handleEvent({
      id: eventId,
      type: "github.ci.failed",
      payload: JSON.stringify({ runId: 333, workflow: "CI" }),
    });

    const runningSnapshot = await runtime.snapshot();
    const runningTask = runningSnapshot.tasks[0];
    const runningExecution = runningSnapshot.executions[0];

    // Cannot approve a running task
    await expect(runtime.approveTask(runningTask.id)).rejects.toThrow("running");

    // Cannot reject a running task
    await expect(runtime.rejectTask(runningTask.id)).rejects.toThrow("running");

    await runtime.requestApproval({
      executionId: runningExecution.id,
      taskId: runningTask.id,
      approvalPayload: { fix: "test", action: "continue" },
    });

    // Callback retries for the same approval request are idempotent.
    await runtime.requestApproval({
      executionId: runningExecution.id,
      taskId: runningTask.id,
      approvalPayload: { action: "continue", fix: "test" },
    });

    // Approve
    await runtime.approveTask(runningTask.id);

    // Repeated approval does not create another execution.
    await runtime.approveTask(runningTask.id);

    // Cannot reject after approval (task is running, not waiting)
    await expect(runtime.rejectTask(runningTask.id)).rejects.toThrow("already approved");
  });

  test("startup recovery preserves waiting tasks", async () => {
    const eventId = generateId("test-recovery-waiting");
    runtime = new PersistentMindRuntime(TEST_MIND_ID, {
      start: async (_task, execution) => {
        return {
          ...execution,
          workflowRunId: 12345,
          status: "running",
        };
      },
      status: async () => "running",
      stop: async () => {},
    }, { intervalMs: 100, timeoutMs: 5000 });
    await runtime.initialize();

    await runtime.handleEvent({
      id: eventId,
      type: "github.ci.failed",
      payload: JSON.stringify({ runId: 444, workflow: "CI" }),
    });

    const runningSnapshot = await runtime.snapshot();
    const runningTask = runningSnapshot.tasks[0];

    await runtime.requestApproval({
      executionId: runningSnapshot.executions[0].id,
      taskId: runningTask.id,
      approvalPayload: { fix: "test fix" },
    });

    const waitingSnapshot = await runtime.snapshot();
    expect(waitingSnapshot.tasks[0].status).toBe("waiting");
    expect(waitingSnapshot.tasks[0].approvalPayload).toEqual({ fix: "test fix" });
    expect(waitingSnapshot.mind.state).toBe("waiting");

    // Simulate restart - create new runtime instance
    runtime = new PersistentMindRuntime(TEST_MIND_ID, {
      start: async (_task, execution) => ({
        ...execution,
        workflowRunId: 54321,
        status: "completed",
        result: "Continued after restart",
      }),
      status: async () => "running",
      stop: async () => {},
    }, { intervalMs: 100, timeoutMs: 5000 });
    await runtime.initialize();

    const recoveredSnapshot = await runtime.snapshot();
    // Waiting tasks and the waiting Mind state survive process restart.
    expect(recoveredSnapshot.tasks[0].status).toBe("waiting");
    expect(recoveredSnapshot.tasks[0].approvalPayload).toEqual({ fix: "test fix" });
    expect(recoveredSnapshot.mind.state).toBe("waiting");

    await runtime.approveTask(recoveredSnapshot.tasks[0].id);
    const resumedSnapshot = await runtime.snapshot();
    expect(resumedSnapshot.tasks[0].status).toBe("completed");
    expect(resumedSnapshot.tasks[0].result).toBe("Continued after restart");
    expect(resumedSnapshot.mind.state).toBe("sleeping");
  });

  test("approval idempotency: duplicate approve/reject is no-op", async () => {
    const eventId = generateId("test-approval-idempotency");
    const continuationResult = "Resumed after approval";
    let startCallCount = 0;
    runtime = new PersistentMindRuntime(TEST_MIND_ID, {
      start: async (_task, execution) => {
        startCallCount++;
        return {
          ...execution,
          workflowRunId: 12345,
          status: startCallCount === 2 ? "completed" : "running",
          result: startCallCount === 2 ? continuationResult : undefined,
        };
      },
      status: async () => "completed",
      stop: async () => {},
    });
    await runtime.initialize();

    await runtime.handleEvent({
      id: eventId,
      type: "github.ci.failed",
      payload: JSON.stringify({ runId: 555, workflow: "CI" }),
    });

    const runningSnapshot = await runtime.snapshot();
    const runningTask = runningSnapshot.tasks[0];
    const runningExecution = runningSnapshot.executions[0];

    await runtime.requestApproval({
      executionId: runningExecution.id,
      taskId: runningTask.id,
      approvalPayload: { fix: "test" },
    });

    await runtime.approveTask(runningTask.id);

    // Duplicate approve should be no-op.
    await runtime.approveTask(runningTask.id);

    const snapshot = await runtime.snapshot();
    expect(snapshot.tasks[0].status).toBe("completed");
    expect(snapshot.tasks[0].result).toBe(continuationResult);
    expect(snapshot.executions.length).toBe(2); // One execution requested approval; one resumed it.

    // Test reject idempotency
    const eventId2 = generateId("test-reject-idempotency");
    await runtime.handleEvent({
      id: eventId2,
      type: "github.ci.failed",
      payload: JSON.stringify({ runId: 666, workflow: "CI" }),
    });

    const runningSnapshot2 = await runtime.snapshot();
    const runningTask2 = runningSnapshot2.tasks.find((task) => task.eventId === eventId2);
    const runningExecution2 = runningSnapshot2.executions.find((execution) => execution.taskId === runningTask2?.id);
    if (!runningTask2 || !runningExecution2) {
      throw new Error("Expected the second task and its execution");
    }

    await runtime.requestApproval({
      executionId: runningExecution2.id,
      taskId: runningTask2.id,
      approvalPayload: { fix: "test" },
    });

    await runtime.rejectTask(runningTask2.id);
    await runtime.rejectTask(runningTask2.id); // Duplicate reject

    const rejectedSnapshot = await runtime.snapshot();
    const rejectedTask = rejectedSnapshot.tasks.find((task) => task.id === runningTask2.id);
    expect(rejectedTask?.status).toBe("failed");
    expect(rejectedTask?.error).toBe("Rejected by human");
  });
});