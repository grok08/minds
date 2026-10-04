import { Task } from "../runtime/src/domain/types.ts";
import { Execution } from "../runtime/src/domain/types.ts";

export type ExecutionStatus = "running" | "completed" | "failed";

export interface AgentProvider {
  start(task: Task, execution: Execution): Promise<Execution>;

  status(execution: Execution): Promise<ExecutionStatus>;

  stop(execution: Execution): Promise<void>;
}