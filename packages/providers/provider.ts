import type { Task, Execution } from "../runtime/src/domain/types.ts";
import type { MemoryContextEntry } from "../memory/src/types.ts";

export type ExecutionStatus = "running" | "completed" | "failed";

export interface AgentProvider {
  start(
    task: Task,
    execution: Execution,
    memoryContext: MemoryContextEntry[]
  ): Promise<Execution>;

  status(execution: Execution): Promise<ExecutionStatus>;

  stop(execution: Execution): Promise<void>;
}