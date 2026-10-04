import { PersistentMindRuntime } from "../../../packages/runtime/src/runtime.ts";
import { createMockProvider } from "../../../packages/providers/mock-provider.ts";

const runtime = new PersistentMindRuntime("repository", createMockProvider());

await runtime.initialize();

await runtime.handleEvent({
  id: "event-1",
  type: "demo.requested",
  payload: "Run the Phase 1 lifecycle",
});

console.log(JSON.stringify(await runtime.snapshot(), null, 2));