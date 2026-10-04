export type MindState = "sleeping" | "working" | "waiting" | "failed";

export interface MindEvent {
  id: string;
  type: string;
  payload: string;
  mindId?: string;
}

export interface Mind {
  id: string;
  name: string;
  purpose: string;
  state: MindState;
  createdAt: Date;
  updatedAt: Date;
}

export interface MindRow {
  id: string;
  name: string;
  purpose: string;
  state: MindState;
  created_at: Date;
  updated_at: Date;
}

export interface Task {
  id: string;
  mindId: string;
  type: string;
  description: string;
  status: "pending" | "running" | "completed" | "failed" | "waiting";
  eventId: string;
  result?: string;
  error?: string;
  approvalPayload?: Record<string, unknown>;
  approvalRequestedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskRow {
  id: string;
  mind_id: string;
  type: string;
  description: string;
  status: "pending" | "running" | "completed" | "failed" | "waiting";
  event_id: string;
  result?: string;
  error?: string;
  approval_payload?: Record<string, unknown> | null;
  approval_requested_at?: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface Execution {
  id: string;
  taskId: string;
  provider: string;
  status: "running" | "completed" | "failed";
  result?: string;
  error?: string;
  startedAt: Date;
  completedAt?: Date;
  workflowRunId?: number;
}

export interface ExecutionRow {
  id: string;
  task_id: string;
  provider: string;
  status: "running" | "completed" | "failed";
  result?: string;
  error?: string;
  started_at: Date;
  completed_at?: Date;
  workflow_run_id?: number | string | null;
}

export interface Snapshot {
  mind: Mind;
  events: MindEvent[];
  tasks: Task[];
  executions: Execution[];
}

export function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

export function toMind(row: MindRow): Mind {
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    mindId: row.mind_id,
    type: row.type,
    description: row.description,
    status: row.status,
    eventId: row.event_id,
    result: row.result,
    error: row.error,
    approvalPayload: row.approval_payload ?? undefined,
    approvalRequestedAt: row.approval_requested_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toExecution(row: ExecutionRow): Execution {
  const workflowRunId = row.workflow_run_id == null ? undefined : Number(row.workflow_run_id);
  if (workflowRunId !== undefined && (!Number.isSafeInteger(workflowRunId) || workflowRunId <= 0)) {
    throw new Error("Invalid workflow run ID in execution row");
  }

  return {
    id: row.id,
    taskId: row.task_id,
    provider: row.provider,
    status: row.status,
    result: row.result,
    error: row.error,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    workflowRunId,
  };
}

export interface Repository {
  id: string;
  mindId: string;
  githubOwner: string;
  githubRepo: string;
  webhookSecret: string;
  githubToken: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface RepositoryRow {
  id: string;
  mind_id: string;
  github_owner: string;
  github_repo: string;
  webhook_secret: string;
  github_token: string;
  created_at: Date;
  updated_at: Date;
}

export interface Approval {
  id: string;
  taskId: string;
  status: "pending" | "approved" | "rejected";
  decision?: "approved" | "rejected";
  continuationData?: Record<string, unknown>;
  createdAt: Date;
  decidedAt?: Date;
}

export interface ApprovalRow {
  id: string;
  task_id: string;
  status: "pending" | "approved" | "rejected";
  decision?: "approved" | "rejected" | null;
  continuation_data?: Record<string, unknown> | null;
  created_at: Date;
  decided_at?: Date | null;
}

export interface GitHubEventPayload {
  repository?: string;
  workflow?: string;
  runId?: number;
  branch?: string;
  sha?: string;
  conclusion?: string;
  url?: string;
  prNumber?: number;
  title?: string;
  headSha?: string;
  headRef?: string;
  baseRef?: string;
  message?: string;
  requiresApproval?: boolean;
}

export function toRepository(row: RepositoryRow): Repository {
  return {
    id: row.id,
    mindId: row.mind_id,
    githubOwner: row.github_owner,
    githubRepo: row.github_repo,
    webhookSecret: row.webhook_secret,
    githubToken: row.github_token,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}