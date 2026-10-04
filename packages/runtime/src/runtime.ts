import { isDeepStrictEqual } from "node:util";
import { query, transaction, getClient } from "../../db/src/client.ts";
import {
  MindState,
  Mind,
  MindRow,
  Task,
  TaskRow,
  Execution,
  ExecutionRow,
  MindEvent,
  Snapshot,
  generateId,
  toMind,
  toTask,
  toExecution,
} from "./domain/types.ts";
import { AgentProvider, ExecutionStatus } from "../../providers/provider.ts";
import { MindMemoryStore } from "../../memory/src/memory.ts";
import type { MemoryContent, MemoryEntry, MemoryType } from "../../memory/src/types.ts";

export interface PollingConfig {
  intervalMs: number;
  timeoutMs: number;
  callbackGracePeriodMs: number;
}

export class PersistentMindRuntime {
  private readonly mindId: string;
  private readonly memory: MindMemoryStore;
  private mind: Mind | null = null;
  private readonly provider: AgentProvider;
  private readonly pollingConfig: PollingConfig;
  private pollingInterval: ReturnType<typeof setInterval> | null = null;
  private isPolling = false;
  private isPollInFlight = false;
  private shutdownPromise: Promise<void> | null = null;
  private shutdownResolve: (() => void) | null = null;

  constructor(
    mindId: string = "repository",
    provider: AgentProvider,
    pollingConfig: Partial<PollingConfig> = {}
  ) {
    this.mindId = mindId;
    this.memory = new MindMemoryStore(mindId);
    this.provider = provider;
    this.pollingConfig = {
      intervalMs: pollingConfig.intervalMs ?? 10000,
      timeoutMs: pollingConfig.timeoutMs ?? 300000,
      callbackGracePeriodMs: pollingConfig.callbackGracePeriodMs ?? 120000,
    };
  }

  async initialize(): Promise<void> {
    await this.ensureMindExists();
    await this.recoverState();
  }

  async remember(type: MemoryType, content: MemoryContent): Promise<MemoryEntry> {
    if (!this.mind) {
      throw new Error("Runtime not initialized");
    }
    return this.memory.remember(type, content);
  }

  async getMemory(limit?: number): Promise<MemoryEntry[]> {
    if (!this.mind) {
      throw new Error("Runtime not initialized");
    }
    return this.memory.list(limit);
  }

  private async ensureMindExists(): Promise<void> {
    const result = await query<MindRow>(
      "SELECT * FROM minds WHERE id = $1",
      [this.mindId]
    );

    if (result.rows.length === 0) {
      const now = new Date();
      await query(
        `INSERT INTO minds (id, name, purpose, state, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          this.mindId,
          "Repository Mind",
          "Keep the configured GitHub repository healthy.",
          "sleeping",
          now,
          now,
        ]
      );
      this.mind = {
        id: this.mindId,
        name: "Repository Mind",
        purpose: "Keep the configured GitHub repository healthy.",
        state: "sleeping",
        createdAt: now,
        updatedAt: now,
      };
    } else {
      this.mind = toMind(result.rows[0]);
    }
  }

  private async recoverState(): Promise<void> {
    const incompleteTasks = await query<TaskRow>(
      `SELECT * FROM tasks 
       WHERE mind_id = $1 AND status IN ('pending', 'running')
       ORDER BY created_at ASC`,
      [this.mindId]
    );

    console.log(`Recovery check for mind ${this.mindId}: found ${incompleteTasks.rows.length} incomplete tasks`);

    if (incompleteTasks.rows.length > 0) {
      console.log(`Recovering ${incompleteTasks.rows.length} incomplete tasks`);
      
      for (const taskRow of incompleteTasks.rows) {
        const task = toTask(taskRow);
        await transaction(async (client) => {
          const executions = await client.query<ExecutionRow>(
            "SELECT * FROM executions WHERE task_id = $1 ORDER BY started_at DESC LIMIT 1",
            [task.id]
          );

          if (executions.rows.length > 0) {
            const execution = executions.rows[0];
            if (execution.status === "running") {
              await client.query(
                "UPDATE executions SET status = 'failed', error = $1, completed_at = $2 WHERE id = $3",
                ["Execution interrupted by restart", new Date(), execution.id]
              );
            }
          }

          await client.query(
            "UPDATE tasks SET status = 'failed', error = $1, updated_at = $2 WHERE id = $3",
            ["Task interrupted by runtime restart", new Date(), task.id]
          );
          await client.query(
            "UPDATE events SET processed = true WHERE id = $1",
            [task.eventId]
          );
        });
      }

    }

    const waitingTasks = await query<{ id: string }>(
      `SELECT t.id
       FROM tasks t
       WHERE t.mind_id = $1
         AND t.status = 'waiting'
         AND EXISTS (
           SELECT 1 FROM approvals a
           WHERE a.task_id = t.id AND a.status = 'pending'
         )
       ORDER BY t.created_at ASC`,
      [this.mindId]
    );

    const invalidWaitingTasks = await query<{ id: string }>(
      `SELECT t.id
       FROM tasks t
       WHERE t.mind_id = $1
         AND t.status = 'waiting'
         AND NOT EXISTS (
           SELECT 1 FROM approvals a
           WHERE a.task_id = t.id AND a.status = 'pending'
         )
       LIMIT 1`,
      [this.mindId]
    );
    if (invalidWaitingTasks.rows.length > 0) {
      throw new Error(`Waiting task ${invalidWaitingTasks.rows[0].id} has no pending approval`);
    }

    await this.transitionState(waitingTasks.rows.length > 0 ? "waiting" : "sleeping");
    this.mind = await this.loadMind();
  }

  private async loadMind(): Promise<Mind> {
    const result = await query<MindRow>(
      "SELECT * FROM minds WHERE id = $1",
      [this.mindId]
    );
    return toMind(result.rows[0]);
  }

  async handleEvent(event: MindEvent): Promise<void> {
    const eventId = event.id;

    const existingEvent = await query(
      "SELECT id FROM events WHERE id = $1",
      [eventId]
    );

    if (existingEvent.rows.length > 0) {
      console.log(`Event ${eventId} already processed, skipping (idempotency)`);
      return;
    }

    if (!this.mind) {
      throw new Error("Runtime not initialized");
    }

    if (this.mind.state !== "sleeping") {
      throw new Error(`Cannot wake a Mind that is ${this.mind.state}`);
    }

    await this.persistEvent(event);
    await this.transitionState("working");

    const task: Task = {
      id: generateId("task"),
      mindId: this.mindId,
      type: event.type,
      description: `${event.type}: ${event.payload}`,
      status: "running",
      eventId: event.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.persistTask(task);

    const execution: Execution = {
      id: generateId("execution"),
      taskId: task.id,
      provider: "github-worker",
      status: "running",
      startedAt: new Date(),
    };

    await this.persistExecution(execution);

    try {
      const memoryContext = await this.memory.loadWorkerContext();
      const providerExecution = await this.provider.start(task, execution, memoryContext);
      
      if (providerExecution.workflowRunId) {
        await query(
          `UPDATE executions SET workflow_run_id = $1 WHERE id = $2`,
          [providerExecution.workflowRunId, execution.id]
        );
      }
      
      if (providerExecution.status === "completed") {
        await this.recordExecutionResult({
          executionId: execution.id,
          taskId: task.id,
          status: providerExecution.result ? "completed" : "failed",
          result: providerExecution.result,
          error: providerExecution.result ? undefined : "Worker completed without a result",
          failureMindState: "failed",
        });
      } else if (providerExecution.status === "failed") {
        await this.recordExecutionResult({
          executionId: execution.id,
          taskId: task.id,
          status: "failed",
          error: providerExecution.error ?? "Worker failed",
          failureMindState: "failed",
        });
      } else {
        await query("UPDATE events SET processed = true WHERE id = $1", [eventId]);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.recordExecutionResult({
        executionId: execution.id,
        taskId: task.id,
        status: "failed",
        error: message,
        failureMindState: "failed",
      });
      throw error;
    }
  }

  private async persistEvent(event: MindEvent): Promise<void> {
    await query(
      `INSERT INTO events (id, type, mind_id, payload, processed, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [event.id, event.type, this.mindId, JSON.stringify({ text: event.payload }), false, new Date()]
    );
  }

  private async persistTask(task: Task): Promise<void> {
    await query(
      `INSERT INTO tasks (id, mind_id, type, description, status, event_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [task.id, task.mindId, task.type, task.description, task.status, task.eventId, task.createdAt, task.updatedAt]
    );
  }

  private async persistExecution(execution: Execution): Promise<void> {
    await query(
      `INSERT INTO executions (id, task_id, provider, status, started_at, workflow_run_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [execution.id, execution.taskId, execution.provider, execution.status, execution.startedAt, execution.workflowRunId ?? null]
    );
  }

  private async transitionState(newState: MindState): Promise<void> {
    if (!this.mind) return;

    const oldState = this.mind.state;
    if (oldState === newState) return;

    const now = new Date();
    await query(
      `UPDATE minds SET state = $1, updated_at = $2 WHERE id = $3`,
      [newState, now, this.mindId]
    );

    await query(
      `INSERT INTO state_transitions (id, mind_id, from_state, to_state, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [generateId("transition"), this.mindId, oldState, newState, now]
    );

    this.mind.state = newState;
    this.mind.updatedAt = now;
  }

  async registerWorkflowRunId(input: {
    executionId: string;
    taskId: string;
    workflowRunId: number;
  }): Promise<void> {
    if (!this.mind) {
      throw new Error("Runtime not initialized");
    }

    await transaction(async (client) => {
      const executions = await client.query<{
        execution_id: string;
        task_id: string;
        mind_id: string;
      }>(
        `SELECT e.id AS execution_id, e.task_id, t.mind_id
         FROM executions e
         JOIN tasks t ON t.id = e.task_id
         WHERE e.id = $1 AND t.id = $2 AND t.mind_id = $3
         FOR UPDATE OF e`,
        [input.executionId, input.taskId, this.mindId]
      );

      if (executions.rows.length === 0) {
        throw new Error("Execution does not belong to the task and Mind");
      }

      await client.query(
        `UPDATE executions SET workflow_run_id = $1 WHERE id = $2`,
        [input.workflowRunId, input.executionId]
      );
    });
  }

  async recordExecutionResult(input: {
    executionId: string;
    taskId: string;
    status: "completed" | "failed";
    result?: string;
    error?: string;
    failureMindState?: "sleeping" | "failed";
  }): Promise<void> {
    if (!this.mind) {
      throw new Error("Runtime not initialized");
    }

    const now = new Date();
    const result = input.status === "completed" ? input.result ?? "" : null;
    const error = input.status === "failed" ? input.error ?? "Worker failed" : null;

    await transaction(async (client) => {
      const executions = await client.query<{
        execution_status: Execution["status"];
        execution_result: string | null;
        execution_error: string | null;
        task_status: Task["status"];
        task_result: string | null;
        task_error: string | null;
        event_id: string;
        mind_id: string;
        mind_state: MindState;
      }>(
        `SELECT e.status AS execution_status, e.result AS execution_result, e.error AS execution_error,
                t.status AS task_status, t.result AS task_result, t.error AS task_error,
                t.event_id, t.mind_id, m.state AS mind_state
         FROM executions e
         JOIN tasks t ON t.id = e.task_id
         JOIN minds m ON m.id = t.mind_id
         WHERE e.id = $1 AND t.id = $2 AND t.mind_id = $3
         FOR UPDATE OF e, t, m`,
        [input.executionId, input.taskId, this.mindId]
      );

      const execution = executions.rows[0];
      if (!execution) {
        throw new Error("Execution does not belong to the task and Mind");
      }

      const alreadyRecorded = execution.execution_status === input.status &&
        execution.task_status === input.status &&
        (input.status === "completed"
          ? execution.execution_result === result && execution.task_result === result
          : execution.execution_error === error && execution.task_error === error);
      if (alreadyRecorded) return;

      if (execution.execution_status !== "running" || execution.task_status !== "running") {
        throw new Error("Execution result conflicts with its persisted status");
      }

      if (input.status === "completed") {
        await client.query(
          `UPDATE executions SET status = 'completed', result = $1, completed_at = $2 WHERE id = $3`,
          [result, now, input.executionId]
        );
        await client.query(
          `UPDATE tasks SET status = 'completed', result = $1, updated_at = $2 WHERE id = $3`,
          [result, now, input.taskId]
        );
      } else {
        await client.query(
          `UPDATE executions SET status = 'failed', error = $1, completed_at = $2 WHERE id = $3`,
          [error, now, input.executionId]
        );
        await client.query(
          `UPDATE tasks SET status = 'failed', error = $1, updated_at = $2 WHERE id = $3`,
          [error, now, input.taskId]
        );
      }

      await this.memory.recordTaskOutcome(client, {
        taskId: input.taskId,
        status: input.status,
        result: input.status === "completed" ? result ?? undefined : undefined,
        error: input.status === "failed" ? error ?? undefined : undefined,
      });

      await client.query("UPDATE events SET processed = true WHERE id = $1", [execution.event_id]);

      const nextMindState =
        input.status === "failed" ? input.failureMindState ?? "sleeping" : "sleeping";
      if (execution.mind_state !== nextMindState) {
        await client.query(
          "UPDATE minds SET state = $1, updated_at = $2 WHERE id = $3",
          [nextMindState, now, execution.mind_id]
        );
        await client.query(
          `INSERT INTO state_transitions (id, mind_id, from_state, to_state, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            generateId("transition"),
            execution.mind_id,
            execution.mind_state,
            nextMindState,
            now,
          ]
        );
      }
    });

    this.mind = await this.loadMind();
  }

  async requestApproval(input: {
    executionId: string;
    taskId: string;
    approvalPayload: Record<string, unknown>;
  }): Promise<void> {
    if (!this.mind) {
      throw new Error("Runtime not initialized");
    }

    const now = new Date();

    await transaction(async (client) => {
      const taskResult = await client.query<{
        id: string;
        status: Task["status"];
        mind_id: string;
        event_id: string;
        mind_state: MindState;
        execution_status: Execution["status"];
      }>(
        `SELECT t.id, t.status, t.mind_id, t.event_id, m.state AS mind_state,
                e.status AS execution_status
         FROM tasks t
         JOIN executions e ON e.task_id = t.id
         JOIN minds m ON m.id = t.mind_id
         WHERE t.id = $1 AND e.id = $2 AND t.mind_id = $3
         FOR UPDATE OF t, e, m`,
        [input.taskId, input.executionId, this.mindId]
      );

      const task = taskResult.rows[0];
      if (!task) {
        throw new Error("Execution does not belong to the task and Mind");
      }

      if (task.status === "waiting") {
        const approvalResult = await client.query<{
          status: string;
          continuation_data: Record<string, unknown> | null;
        }>(
          `SELECT status, continuation_data
           FROM approvals
           WHERE task_id = $1
           ORDER BY created_at DESC
           LIMIT 1
           FOR UPDATE`,
          [input.taskId]
        );
        const approval = approvalResult.rows[0];
        if (
          approval?.status === "pending" &&
          isDeepStrictEqual(approval.continuation_data, input.approvalPayload)
        ) {
          return;
        }
        throw new Error(`Cannot request approval for task in status: ${task.status}`);
      }

      if (task.status !== "running" || task.execution_status !== "running") {
        throw new Error("Approval can only be requested by a running execution");
      }

      if (task.mind_state !== "working") {
        throw new Error(`Mind is not in working state: ${task.mind_state}`);
      }

      await client.query(
        `UPDATE tasks SET status = 'waiting', approval_payload = $1, approval_requested_at = $2, updated_at = $3 WHERE id = $4`,
        [JSON.stringify(input.approvalPayload), now, now, input.taskId]
      );

      await client.query(
        `INSERT INTO approvals (id, task_id, status, decision, continuation_data, created_at, decided_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [generateId("approval"), input.taskId, "pending", null, JSON.stringify(input.approvalPayload), now, null]
      );

      await client.query(
        `UPDATE executions
         SET status = 'completed', result = $1, completed_at = $2
         WHERE id = $3`,
        [`Approval requested: ${JSON.stringify(input.approvalPayload)}`, now, input.executionId]
      );

      await client.query(
        `UPDATE minds SET state = 'waiting', updated_at = $1 WHERE id = $2`,
        [now, this.mindId]
      );
      await client.query(
        `INSERT INTO state_transitions (id, mind_id, from_state, to_state, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [generateId("transition"), this.mindId, "working", "waiting", now]
      );

      await client.query("UPDATE events SET processed = true WHERE id = $1", [task.event_id]);
    });

    this.mind = await this.loadMind();
  }

  async approveTask(taskId: string): Promise<void> {
    if (!this.mind) {
      throw new Error("Runtime not initialized");
    }

    const now = new Date();

    const continuation = await transaction(async (client) => {
      const taskResult = await client.query<TaskRow & { mind_state: MindState }>(
        `SELECT t.*, m.state AS mind_state
         FROM tasks t
         JOIN minds m ON m.id = t.mind_id
         WHERE t.id = $1 AND t.mind_id = $2
         FOR UPDATE OF t, m`,
        [taskId, this.mindId]
      );
      const taskRow = taskResult.rows[0];
      if (!taskRow) {
        throw new Error("Task does not belong to this Mind");
      }

      const approvalResult = await client.query<{
        id: string;
        status: string;
        decision: "approved" | "rejected" | null;
      }>(
        `SELECT id, status, decision
         FROM approvals
         WHERE task_id = $1
         ORDER BY created_at DESC
         LIMIT 1
         FOR UPDATE`,
        [taskId]
      );
      const approval = approvalResult.rows[0];
      if (!approval) {
        if (taskRow.status !== "waiting") {
          throw new Error(`Cannot approve task in status: ${taskRow.status}`);
        }
        throw new Error("Task has no approval request");
      }

      if (approval.decision === "approved") {
        if (taskRow.status !== "waiting") return null;
        throw new Error("Approved task is still waiting");
      }
      if (approval.decision === "rejected") {
        throw new Error("Task approval was rejected");
      }
      if (approval.status !== "pending") {
        throw new Error("Task has no pending approval");
      }
      if (taskRow.status !== "waiting") {
        throw new Error(`Cannot approve task in status: ${taskRow.status}`);
      }
      if (taskRow.mind_state !== "waiting") {
        throw new Error(`Mind is not in waiting state: ${taskRow.mind_state}`);
      }

      const task = toTask(taskRow);
      const execution: Execution = {
        id: generateId("execution"),
        taskId: task.id,
        provider: "github-worker",
        status: "running",
        startedAt: now,
      };

      await client.query(
        `UPDATE approvals
         SET status = 'approved', decision = 'approved', decided_at = $1
         WHERE id = $2`,
        [now, approval.id]
      );
      await client.query(
        `INSERT INTO executions (id, task_id, provider, status, started_at, workflow_run_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [execution.id, execution.taskId, execution.provider, execution.status, execution.startedAt, null]
      );
      await client.query(
        `UPDATE tasks SET status = 'running', updated_at = $1 WHERE id = $2`,
        [now, taskId]
      );
      await client.query(
        `UPDATE minds SET state = 'working', updated_at = $1 WHERE id = $2`,
        [now, this.mindId]
      );
      await client.query(
        `INSERT INTO state_transitions (id, mind_id, from_state, to_state, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [generateId("transition"), this.mindId, "waiting", "working", now]
      );

      const taskForProvider: Task = { ...task, status: "running" };
      return {
        task: taskForProvider,
        execution,
      };
    });

    this.mind = await this.loadMind();
    if (!continuation) return;

    try {
      const memoryContext = await this.memory.loadWorkerContext();
      const providerExecution = await this.provider.start(
        continuation.task,
        continuation.execution,
        memoryContext
      );
      if (providerExecution.workflowRunId) {
        await this.registerWorkflowRunId({
          executionId: continuation.execution.id,
          taskId,
          workflowRunId: providerExecution.workflowRunId,
        });
      }

      if (providerExecution.status === "completed") {
        await this.recordExecutionResult({
          executionId: continuation.execution.id,
          taskId,
          status: providerExecution.result ? "completed" : "failed",
          result: providerExecution.result,
          error: providerExecution.result ? undefined : "Worker completed without a result",
        });
      } else if (providerExecution.status === "failed") {
        await this.recordExecutionResult({
          executionId: continuation.execution.id,
          taskId,
          status: "failed",
          error: providerExecution.error ?? "Worker failed",
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.recordExecutionResult({
        executionId: continuation.execution.id,
        taskId,
        status: "failed",
        error: message,
      });
      throw error;
    }
  }

  async rejectTask(taskId: string): Promise<void> {
    if (!this.mind) {
      throw new Error("Runtime not initialized");
    }

    const now = new Date();

    await transaction(async (client) => {
      const taskResult = await client.query<{
        id: string;
        status: Task["status"];
        mind_id: string;
        event_id: string;
        mind_state: MindState;
      }>(
        `SELECT t.id, t.status, t.mind_id, t.event_id, m.state AS mind_state
         FROM tasks t
         JOIN minds m ON m.id = t.mind_id
         WHERE t.id = $1 AND t.mind_id = $2
         FOR UPDATE OF t, m`,
        [taskId, this.mindId]
      );

      const task = taskResult.rows[0];
      if (!task) {
        throw new Error("Task does not belong to this Mind");
      }

      const approvalResult = await client.query<{
        id: string;
        status: string;
        decision: "approved" | "rejected" | null;
      }>(
        `SELECT id, status, decision
         FROM approvals
         WHERE task_id = $1
         ORDER BY created_at DESC
         LIMIT 1
         FOR UPDATE`,
        [taskId]
      );
      const approval = approvalResult.rows[0];
      if (!approval) {
        if (task.status !== "waiting") {
          throw new Error(`Cannot reject task in status: ${task.status}`);
        }
        throw new Error("Task has no approval request");
      }
      if (approval.decision === "rejected") {
        if (task.status === "failed") return;
        throw new Error("Rejected task is not in a terminal state");
      }
      if (approval.decision === "approved") {
        throw new Error("Task was already approved");
      }
      if (approval.status !== "pending") {
        throw new Error("Task has no pending approval");
      }
      if (task.status !== "waiting") {
        throw new Error(`Cannot reject task in status: ${task.status}`);
      }
      if (task.mind_state !== "waiting") {
        throw new Error(`Mind is not in waiting state: ${task.mind_state}`);
      }

      await client.query(
        `UPDATE approvals
         SET status = 'rejected', decision = 'rejected', decided_at = $1
         WHERE id = $2`,
        [now, approval.id]
      );
      await client.query(
        `UPDATE tasks SET status = 'failed', error = 'Rejected by human', updated_at = $1 WHERE id = $2`,
        [now, taskId]
      );
      await this.memory.recordTaskOutcome(client, {
        taskId,
        status: "rejected",
        error: "Rejected by human",
      });
      await client.query(
        `UPDATE minds SET state = 'sleeping', updated_at = $1 WHERE id = $2`,
        [now, this.mindId]
      );
      await client.query(
        `INSERT INTO state_transitions (id, mind_id, from_state, to_state, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [generateId("transition"), this.mindId, "waiting", "sleeping", now]
      );
      await client.query("UPDATE events SET processed = true WHERE id = $1", [task.event_id]);
    });

    this.mind = await this.loadMind();
  }

  async snapshot(): Promise<Snapshot> {
    if (!this.mind) {
      throw new Error("Runtime not initialized");
    }

    const [events, tasks, executions] = await Promise.all([
      query<MindEvent>("SELECT id, type, payload, mind_id FROM events WHERE mind_id = $1 ORDER BY created_at", [this.mindId]),
      query<TaskRow>("SELECT * FROM tasks WHERE mind_id = $1 ORDER BY created_at", [this.mindId]),
      query<ExecutionRow>(
        `SELECT e.id, e.task_id, e.provider, e.status, e.result, e.error, e.started_at, e.completed_at, e.workflow_run_id
         FROM executions e
         JOIN tasks t ON e.task_id = t.id
         WHERE t.mind_id = $1
         ORDER BY e.started_at`,
        [this.mindId]
      ),
    ]);

    return {
      mind: { ...this.mind },
      events: events.rows.map((e) => ({ id: e.id, type: e.type, payload: e.payload })),
      tasks: tasks.rows.map(toTask),
      executions: executions.rows.map(toExecution),
    };
  }

  getMindState(): MindState {
    return this.mind?.state ?? "sleeping";
  }

  startPolling(): void {
    if (this.pollingInterval) return;
    this.isPolling = true;
    this.pollingInterval = setInterval(() => {
      if (!this.isPolling) return;
      this.pollExecutions().catch((error) => {
        console.error("Polling error:", error);
      });
    }, this.pollingConfig.intervalMs);
    console.log(`Started execution polling for mind ${this.mindId} (interval: ${this.pollingConfig.intervalMs}ms)`);
  }

  stopPolling(): Promise<void> {
    if (!this.pollingInterval) {
      return Promise.resolve();
    }
    this.isPolling = false;
    clearInterval(this.pollingInterval);
    this.pollingInterval = null;
    console.log(`Stopped execution polling for mind ${this.mindId}`);

    // Wait for in-flight poll to complete
    this.shutdownPromise = new Promise((resolve) => {
      this.shutdownResolve = resolve;
      // If no poll is in flight, resolve immediately
      if (!this.isPollInFlight) {
        resolve();
      }
    });
    return this.shutdownPromise;
  }

  async pollExecutions(): Promise<void> {
    // Single-flight guard: skip if a poll is already in progress
    if (this.isPollInFlight) {
      return;
    }
    this.isPollInFlight = true;

    try {
      const runningExecutions = await query<ExecutionRow>(
        `SELECT e.* FROM executions e
         JOIN tasks t ON e.task_id = t.id
         WHERE t.mind_id = $1 AND e.status = 'running'
         ORDER BY e.started_at ASC`,
        [this.mindId]
      );

      const now = Date.now();
      const gracePeriodMs = this.pollingConfig.callbackGracePeriodMs;

      for (const executionRow of runningExecutions.rows) {
        const execution = toExecution(executionRow);
        
        // Check for timeout based on startedAt for ALL running executions (with or without run ID)
        const elapsed = execution.startedAt ? now - execution.startedAt.getTime() : 0;
        const isTimedOut = elapsed >= this.pollingConfig.timeoutMs;

        if (isTimedOut) {
          // Timeout recovery: execution has been running past the timeout deadline
          try {
            // Best-effort cancellation if we have a run ID
            if (execution.workflowRunId) {
              try {
                await this.provider.stop(execution);
              } catch (stopError) {
                console.error(`Failed to stop execution ${execution.id} on timeout:`, stopError);
              }
            }
            await this.recordExecutionResult({
              executionId: execution.id,
              taskId: execution.taskId,
              status: "failed",
              error: `Worker timed out after ${this.pollingConfig.timeoutMs}ms`,
            });
            console.log(`Timed out execution ${execution.id} for task ${execution.taskId}`);
          } catch (error) {
            console.error(`Failed to timeout execution ${execution.id}:`, error);
          }
          continue;
        }

        // Only poll provider status if we have a workflow run ID
        if (!execution.workflowRunId) {
          // No run ID yet - check if we're past the grace period for callback registration
          const timeSinceStarted = execution.startedAt ? now - execution.startedAt.getTime() : 0;
          if (timeSinceStarted >= gracePeriodMs) {
            // Grace period expired without run ID registration - fail with missing-result error
            try {
              await this.recordExecutionResult({
                executionId: execution.id,
                taskId: execution.taskId,
                status: "failed",
                error: `Worker did not register run ID within ${gracePeriodMs}ms grace period`,
              });
              console.log(`Failed execution ${execution.id} for task ${execution.taskId}: missing run ID after grace period`);
            } catch (error) {
              console.error(`Failed to record missing run ID failure for execution ${execution.id}:`, error);
            }
          }
          continue;
        }

        // Poll provider status for executions with run ID
        let status: ExecutionStatus;
        try {
          status = await this.provider.status(execution);
        } catch (statusError) {
          // Transient GitHub API error - log but don't fail the execution
          console.warn(`Transient error polling status for execution ${execution.id}:`, statusError);
          continue;
        }

        if (status !== "running") {
          try {
            // For completed status, require a worker result (non-empty)
            if (status === "completed") {
              if (!execution.result || execution.result.trim() === "") {
                // Workflow completed but no worker result recorded - fail with missing-result error
                await this.recordExecutionResult({
                  executionId: execution.id,
                  taskId: execution.taskId,
                  status: "failed",
                  error: "Workflow completed but worker result not recorded",
                });
                console.log(`Failed execution ${execution.id} for task ${execution.taskId}: missing worker result`);
              } else {
                // Valid completed result
                await this.recordExecutionResult({
                  executionId: execution.id,
                  taskId: execution.taskId,
                  status,
                  result: execution.result,
                });
              }
            } else {
              // Failed status - use error from execution or default
              await this.recordExecutionResult({
                executionId: execution.id,
                taskId: execution.taskId,
                status,
                error: execution.error ?? "Workflow failed",
              });
            }
          } catch (error) {
            console.error(`Failed to record result for execution ${execution.id}:`, error);
          }
        }
      }
    } finally {
      this.isPollInFlight = false;
      // Resolve shutdown promise if waiting
      if (this.shutdownResolve) {
        this.shutdownResolve();
        this.shutdownResolve = null;
        this.shutdownPromise = null;
      }
    }
  }
}