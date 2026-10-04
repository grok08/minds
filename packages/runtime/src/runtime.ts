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

export interface PollingConfig {
  intervalMs: number;
  timeoutMs: number;
  callbackGracePeriodMs: number;
}

export class PersistentMindRuntime {
  private readonly mindId: string;
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

    await this.transitionState("sleeping");
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
      const providerExecution = await this.provider.start(task, execution);
      
      if (providerExecution.workflowRunId) {
        await query(
          `UPDATE executions SET workflow_run_id = $1 WHERE id = $2`,
          [providerExecution.workflowRunId, execution.id]
        );
      }
      
      if (providerExecution.status === "completed" && providerExecution.result) {
        await this.completeTask(task.id, providerExecution.result);
        await this.completeExecution(execution.id, providerExecution.result);
        await this.transitionState("sleeping");
      } else if (providerExecution.status === "failed" && providerExecution.error) {
        await this.failTask(task.id, providerExecution.error);
        await this.failExecution(execution.id, providerExecution.error);
        await this.transitionState("failed");
      }
      
      await query(
        "UPDATE events SET processed = true WHERE id = $1",
        [eventId]
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      
      await this.failTask(task.id, message);
      await this.failExecution(execution.id, message);
      await this.transitionState("failed");
      
      await query(
        "UPDATE events SET processed = true WHERE id = $1",
        [eventId]
      );
      
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

  private async completeTask(taskId: string, result: string): Promise<void> {
    const now = new Date();
    await query(
      `UPDATE tasks SET status = 'completed', result = $1, updated_at = $2 WHERE id = $3`,
      [result, now, taskId]
    );
  }

  private async failTask(taskId: string, error: string): Promise<void> {
    const now = new Date();
    await query(
      `UPDATE tasks SET status = 'failed', error = $1, updated_at = $2 WHERE id = $3`,
      [error, now, taskId]
    );
  }

  private async completeExecution(executionId: string, result: string): Promise<void> {
    const now = new Date();
    await query(
      `UPDATE executions SET status = 'completed', result = $1, completed_at = $2 WHERE id = $3`,
      [result, now, executionId]
    );
  }

  private async failExecution(executionId: string, error: string): Promise<void> {
    const now = new Date();
    await query(
      `UPDATE executions SET status = 'failed', error = $1, completed_at = $2 WHERE id = $3`,
      [error, now, executionId]
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

      await client.query("UPDATE events SET processed = true WHERE id = $1", [execution.event_id]);

      if (execution.mind_state !== "sleeping") {
        await client.query(
          "UPDATE minds SET state = 'sleeping', updated_at = $1 WHERE id = $2",
          [now, execution.mind_id]
        );
        await client.query(
          `INSERT INTO state_transitions (id, mind_id, from_state, to_state, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [generateId("transition"), execution.mind_id, execution.mind_state, "sleeping", now]
        );
      }
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