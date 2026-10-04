export const MEMORY_TYPES = [
  "fact",
  "action",
  "decision",
  "repository_knowledge",
  "task_outcome",
] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface MemoryContent {
  [key: string]: JsonValue;
}

export interface MemoryEntry {
  id: string;
  mindId: string;
  type: MemoryType;
  content: MemoryContent;
  createdAt: Date;
}

export interface MemoryContextEntry {
  type: MemoryType;
  content: MemoryContent;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (typeof value !== "object") {
    return false;
  }

  return Object.values(value).every(isJsonValue);
}

export function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === "string" && MEMORY_TYPES.some((type) => type === value);
}

function isMemoryContent(value: unknown): value is MemoryContent {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    isJsonValue(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseMemoryContext(value: unknown): MemoryContextEntry[] {
  if (!Array.isArray(value)) {
    throw new Error("Memory context must be an array");
  }

  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Invalid memory context entry at index ${index}`);
    }
    const record = entry;
    if (!isMemoryType(record.type) || !isMemoryContent(record.content)) {
      throw new Error(`Invalid memory context entry at index ${index}`);
    }

    return {
      type: record.type,
      content: record.content,
    };
  });
}

export function assertMemoryContent(value: unknown): asserts value is MemoryContent {
  if (!isMemoryContent(value)) {
    throw new Error("Memory content must be a JSON object");
  }
}
