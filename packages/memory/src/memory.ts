import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { query } from "../../db/src/client.ts";
import {
  assertMemoryContent,
  isMemoryType,
  type MemoryContent,
  type MemoryContextEntry,
  type MemoryEntry,
  type MemoryType,
} from "./types.ts";

interface MemoryRow {
  id: string;
  mind_id: string;
  type: string;
  content: unknown;
  created_at: Date | string;
}

const DEFAULT_MEMORY_LIMIT = 50;
const MAX_MEMORY_LIMIT = 100;
const WORKER_MEMORY_LIMIT = 20;
const WORKER_MEMORY_MAX_CHARACTERS = 16000;

function toMemoryEntry(row: MemoryRow): MemoryEntry {
  if (!isMemoryType(row.type)) {
    throw new Error(`Invalid memory type in database: ${row.type}`);
  }
  assertMemoryContent(row.content);

  return {
    id: row.id,
    mindId: row.mind_id,
    type: row.type,
    content: row.content,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
  };
}

export class MindMemoryStore {
  constructor(private readonly mindId: string) {
    if (!mindId.trim()) {
      throw new Error("Mind ID must not be empty");
    }
  }

  async remember(type: MemoryType, content: MemoryContent): Promise<MemoryEntry> {
    assertMemoryContent(content);
    const result = await query<MemoryRow>(
      `INSERT INTO memory (id, mind_id, type, content, created_at)
       VALUES ($1, $2, $3, $4::jsonb, NOW())
       RETURNING id, mind_id, type, content, created_at`,
      [randomUUID(), this.mindId, type, JSON.stringify(content)]
    );
    return toMemoryEntry(result.rows[0]);
  }

  async list(limit = DEFAULT_MEMORY_LIMIT): Promise<MemoryEntry[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MEMORY_LIMIT) {
      throw new Error(`Memory limit must be between 1 and ${MAX_MEMORY_LIMIT}`);
    }

    const result = await query<MemoryRow>(
      `SELECT id, mind_id, type, content, created_at
       FROM memory
       WHERE mind_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      [this.mindId, limit]
    );

    return result.rows.map(toMemoryEntry).reverse();
  }

  async loadWorkerContext(): Promise<MemoryContextEntry[]> {
    const entries = await this.list(WORKER_MEMORY_LIMIT);
    const selected: MemoryContextEntry[] = [];
    let characterCount = 2;

    for (const entry of entries.slice().reverse()) {
      const contextEntry = { type: entry.type, content: entry.content };
      const entrySize = JSON.stringify(contextEntry).length + (selected.length > 0 ? 1 : 0);
      if (characterCount + entrySize > WORKER_MEMORY_MAX_CHARACTERS) {
        break;
      }
      selected.push(contextEntry);
      characterCount += entrySize;
    }

    return selected.reverse();
  }

  async recordTaskOutcome(
    client: PoolClient,
    input: {
      taskId: string;
      status: "completed" | "failed" | "rejected";
      result?: string;
      error?: string;
    }
  ): Promise<void> {
    const content: MemoryContent = {
      taskId: input.taskId,
      status: input.status,
    };
    if (input.result !== undefined) {
      content.result = input.result;
    }
    if (input.error !== undefined) {
      content.error = input.error;
    }

    await client.query(
      `INSERT INTO memory (id, mind_id, type, content, created_at)
       VALUES ($1, $2, 'task_outcome', $3::jsonb, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [`task-outcome-${input.taskId}`, this.mindId, JSON.stringify(content)]
    );
  }
}
