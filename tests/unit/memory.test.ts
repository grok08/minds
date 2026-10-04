import { describe, expect, test } from "bun:test";
import { parseMemoryContext } from "../../packages/memory/src/types.ts";
import type { MemoryContextEntry } from "../../packages/memory/src/types.ts";

describe("parseMemoryContext", () => {
  test("accepts a structured Mind memory snapshot", () => {
    const context: MemoryContextEntry[] = [
      { type: "fact", content: { statement: "The repository uses Bun." } },
      { type: "task_outcome", content: { status: "completed", taskId: "task-1" } },
    ];

    expect(parseMemoryContext(context)).toEqual(context);
  });

  test("rejects malformed memory context instead of silently dropping it", () => {
    expect(() => parseMemoryContext({})).toThrow("Memory context must be an array");
    expect(() => parseMemoryContext([
      { type: "unknown", content: { statement: "invalid category" } },
    ])).toThrow("Invalid memory context entry at index 0");
    expect(() => parseMemoryContext([
      { type: "fact", content: { count: Number.NaN } },
    ])).toThrow("Invalid memory context entry at index 0");
  });
});
