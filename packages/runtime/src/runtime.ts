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
import { AgentProvider } from "../../providers/provider.ts";

export class PersistentMindRuntime {
  private readonly mindId: string;
  private mind: Mind | null = null;
  private readonly provider: AgentProvider;

  constructor(mindId: string = "repository", provider: AgentProvider) {
    this.mindId = mindId;
    this.provider = provider;
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

  async snapshot(): Promise<Snapshot> {
    if (!this.mind) {
      throw new Error("Runtime not initialized");
    }

    const [events, tasks, executions] = await Promise.all([
      query<MindEvent>("SELECT id, type, payload, mind_id FROM events WHERE mind_id = $1 ORDER BY created_at", [this.mindId]),
      query<TaskRow>("SELECT * FROM tasks WHERE mind_id = $1 ORDER BY created_at", [this.mindId]),
      query<ExecutionRow>(
        `SELECT e.id, e.task_id, e.provider, e.status, e.result, e.error, e.started_at, e.completed_at
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

  async pollExecutions(): Promise<void> {
    const runningExecutions = await query<ExecutionRow>(
      `SELECT e.* FROM executions e
       JOIN tasks t ON e.task_id = t.id
       WHERE t.mind_id = $1 AND e.status = 'running'
       ORDER BY e.started_at ASC`,
      [this.mindId]
    );

    for (const executionRow of runningExecutions.rows) {
      const execution = toExecution(executionRow);
      const status = await this.provider.status(execution);
      
      if (status !== "running") {
        const now = new Date();
        if (status === "completed") {
          await query(
            `UPDATE executions SET status = 'completed', completed_at = $1 WHERE id = $2`,
            [now, execution.id]
          );
          await query(
            `UPDATE tasks SET status = 'completed', updated_at = $1 WHERE id = $2`,
            [now, execution.taskId]
          );
        } else if (status === "failed") {
          await query(
            `UPDATE executions SET status = 'failed', error = 'Workflow failed', completed_at = $1 WHERE id = $2`,
            [now, execution.id]
          );
          await query(
            `UPDATE tasks SET status = 'failed', error = 'Workflow failed', updated_at = $1 WHERE id = $2`,
            [now, execution.taskId]
          );
        }
        
        const mindResult = await query("SELECT mind_id FROM tasks WHERE id = $1", [execution.taskId]);
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
            [execution.taskId]
          );
        }
      }
    }
  }
}