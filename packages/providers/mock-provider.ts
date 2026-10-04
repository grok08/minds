import { AgentProvider } from "./provider.ts";
import { Task, Execution } from "../runtime/src/domain/types.ts";

export class MockProvider implements AgentProvider {
  async start(task: Task, execution: Execution): Promise<Execution> {
    execution.status = "completed";
    execution.result = `Mock execution completed for task: ${task.description}`;
    execution.startedAt = new Date();
    execution.completedAt = new Date();
    return execution;
  }

  async status(execution: Execution): Promise<"running" | "completed" | "failed"> {
    return execution.status;
  }

  async stop(execution: Execution): Promise<void> {
    // No-op for mock
  }
}

export function createMockProvider(): MockProvider {
  return new MockProvider();
}