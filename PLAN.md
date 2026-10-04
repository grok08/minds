# Minds

> A persistent agent runtime where the Mind survives even when its workers do not.

---

## 1. Vision

Minds is a runtime for building persistent autonomous entities.

A Mind has:

- Identity
- Purpose
- Goals
- Durable state
- Memory
- Event subscriptions
- Tasks
- Lifecycle
- Ability to wake, act, wait, resume and sleep

The key architectural principle is:

> **The Mind persists. Its executions are disposable.**

Minds is not an agent harness and is not tied to a particular coding agent.

The first MVP will use GitHub as the external environment and a disposable worker for execution, but GitHub and the worker are implementation details rather than the definition of a Mind.

---

# 2. MVP

## Goal

Prove that a persistent Mind can:

1. Exist indefinitely.
2. Sleep while nothing needs to happen.
3. Wake because of an external event.
4. Load its previous state.
5. Create and execute a task.
6. Wait for human input/approval.
7. Resume later.
8. Persist what happened.
9. Recover after the runtime is restarted.

### MVP Mind

Build exactly one Mind:

**Repository Mind**

Responsibility:

> Keep a GitHub repository healthy.

### MVP events

```text
github.ci.failed
github.pull_request.opened
user.message
```

### MVP actions

```text
investigate
prepare_fix
ask_human
```

### MVP lifecycle

```text
                    ┌──────────────┐
                    │    SLEEP     │
                    └──────┬───────┘
                           │ event
                           ▼
                    ┌──────────────┐
                    │     WAKE     │
                    └──────┬───────┘
                           │
                           ▼
                    ┌──────────────┐
                    │    REASON    │
                    └──────┬───────┘
                           │
                           ▼
                    ┌──────────────┐
                    │   EXECUTE    │
                    └──────┬───────┘
                           │
                ┌──────────┼──────────┐
                │          │          │
                ▼          ▼          ▼
             COMPLETE   APPROVAL    FAILURE
                │          │          │
                ▼          ▼          ▼
             SLEEP      WAITING     RETRY/FAIL
                           │
                           │ approval
                           ▼
                         WAKE
```

---

# 3. MVP Success Criteria

The MVP is successful if this scenario works:

```text
1. Repository CI fails
2. GitHub sends an event to Minds
3. Repository Mind wakes
4. Mind creates a durable task
5. Disposable worker executes the task
6. Worker investigates the failure
7. Mind receives the result
8. Mind records what happened
9. Mind goes to SLEEP

10. Runtime is restarted

11. Mind still knows:
    - who it is
    - what it was doing
    - what happened previously
    - outstanding tasks

12. A new event wakes it
13. Mind continues from persisted state
```

The most important test:

> **Kill the worker. Kill the Minds runtime. Restart everything. The Mind must survive.**

---

# 4. Non-Goals for MVP

Do NOT build these initially:

- Multiple Minds
- Mobile application
- Vector database
- RAG system
- Sophisticated semantic memory
- Sub-Minds
- Multi-agent collaboration
- Complex scheduler
- Multiple agent providers
- OpenCode integration
- Codex integration
- Claude integration
- Fancy UI
- Autonomous production deployment
- Complex permissions engine
- Distributed execution
- Kubernetes

The MVP should validate the runtime abstraction before expanding capabilities.

---

# 5. Tech Stack

## Language

**TypeScript**

Reason:

- Fast iteration
- Good backend ecosystem
- Strong typing
- Easy integration with GitHub APIs
- Easy future SDK development

---

## Runtime

**Bun**

The Minds server is a long-lived Bun process.

Responsibilities:

```text
event ingestion
state transitions
task orchestration
execution management
recovery
scheduling
```

---

## API

**Fastify**

Use a lightweight HTTP API for:

```text
POST /events
GET  /minds
GET  /minds/:id
GET  /tasks
GET  /tasks/:id
POST /tasks/:id/approve
POST /tasks/:id/reject
```

---

## Database

**PostgreSQL**

Persist:

```text
minds
mind_state
goals
tasks
events
executions
approvals
memory
state_transitions
```

Do not introduce a vector database in the MVP.

---

## GitHub

GitHub is the first external environment.

Use:

- GitHub Webhooks
- GitHub API
- GitHub Issues
- GitHub Pull Requests
- GitHub Actions

GitHub provides the environment in which the first Mind operates.

It is not the Minds runtime.

---

## Worker

The worker is deliberately disposable.

For MVP:

```text
Minds Runtime
      │
      ▼
GitHub Actions
      │
      ▼
Ephemeral Worker
```

The worker performs the actual repository operation and returns the result.

The exact agent engine can remain behind an interface.

---

## Memory

Start with structured memory.

Example:

```json
{
  "mindId": "repository",
  "facts": [
    "Repository uses TypeScript",
    "CI uses GitHub Actions"
  ],
  "history": [
    "Investigated failing test suite on 2026-10-03"
  ]
}
```

No embeddings initially.

---

## UI

Minimal web UI.

Only expose:

```text
Minds
Tasks
Executions
Events
Current state
Memory
Approvals
```

The UI is an observability/control surface, not the core product.

---

# 6. Architecture

```text
                         ┌─────────────────────────┐
                         │          MINDS          │
                         │     Persistent Runtime  │
                         └────────────┬────────────┘
                                      │
             ┌────────────────────────┼────────────────────────┐
             │                        │                        │
             ▼                        ▼                        ▼
       ┌───────────┐            ┌───────────┐            ┌───────────┐
       │ Identity  │            │   State   │            │  Memory   │
       └───────────┘            └───────────┘            └───────────┘
             │                        │                        │
             └────────────────────────┼────────────────────────┘
                                      │
                                      ▼
                            ┌───────────────────┐
                            │   Mind Runtime    │
                            │                   │
                            │ Wake              │
                            │ Reason            │
                            │ Plan              │
                            │ Wait              │
                            │ Resume            │
                            │ Sleep             │
                            └─────────┬─────────┘
                                      │
                                      ▼
                            ┌───────────────────┐
                            │    Task Engine    │
                            └─────────┬─────────┘
                                      │
                       ┌──────────────┼──────────────┐
                       │              │              │
                       ▼              ▼              ▼
                  GitHub Event     Timer        User Event
                       │              │              │
                       └──────────────┼──────────────┘
                                      │
                                      ▼
                            ┌───────────────────┐
                            │ Provider/Worker   │
                            │     Interface     │
                            └─────────┬─────────┘
                                      │
                                      ▼
                            ┌───────────────────┐
                            │ GitHub Actions    │
                            │ Ephemeral Worker  │
                            └─────────┬─────────┘
                                      │
                                      ▼
                              Result / Event
                                      │
                                      ▼
                            ┌───────────────────┐
                            │   Persist State   │
                            └─────────┬─────────┘
                                      │
                                      ▼
                                    SLEEP
```

---

# 7. Core Architectural Boundary

This is the most important boundary in Minds.

## Minds owns

```text
Identity
Purpose
Goals
State
Memory
Tasks
Events
Lifecycle
Wake/Sleep
Approvals
Execution history
Provider selection
Recovery
```

## Workers own

```text
LLM interaction
Tool execution
Code changes
Shell commands
Tests
Repository manipulation
```

A worker may disappear at any point.

The Mind must remain valid.

---

# 8. Core Interfaces

## Mind

```ts
interface Mind {
  id: string;
  name: string;
  purpose: string;

  goals: Goal[];

  state: MindState;

  subscriptions: EventSubscription[];
}
```

---

## Mind State

```ts
type MindState =
  | "sleeping"
  | "ready"
  | "working"
  | "waiting"
  | "failed";
```

---

## Task

```ts
interface Task {
  id: string;
  mindId: string;

  type: string;
  description: string;

  status: TaskStatus;

  createdAt: Date;
  updatedAt: Date;
}
```

---

## Execution

```ts
interface Execution {
  id: string;
  taskId: string;

  provider: string;

  status: ExecutionStatus;

  startedAt: Date;
  completedAt?: Date;
}
```

---

## Provider

```ts
interface AgentProvider {
  start(task: Task): Promise<Execution>;

  status(
    execution: Execution
  ): Promise<ExecutionStatus>;

  stop(
    execution: Execution
  ): Promise<void>;
}
```

The MVP only needs one implementation.

The interface exists to protect the runtime from being coupled to that implementation.

---

# 9. Event Model

Everything entering the runtime becomes an event.

Example:

```json
{
  "id": "evt_123",
  "type": "github.ci.failed",
  "mindId": "repository",
  "payload": {
    "repository": "owner/repo",
    "workflow": "CI",
    "runId": 12345
  },
  "createdAt": "2026-10-03T12:00:00Z"
}
```

Lifecycle:

```text
EVENT
  ↓
ROUTE
  ↓
WAKE MIND
  ↓
LOAD STATE
  ↓
CREATE TASK
  ↓
EXECUTE
  ↓
PERSIST RESULT
  ↓
TRANSITION
  ↓
SLEEP
```

Events must be durable and idempotent.

---

# 10. Persistence Model

Initial database entities:

```text
minds
├── id
├── name
├── purpose
├── state
└── created_at

tasks
├── id
├── mind_id
├── type
├── description
├── status
└── timestamps

events
├── id
├── type
├── mind_id
├── payload
├── processed
└── timestamps

executions
├── id
├── task_id
├── provider
├── status
└── timestamps

approvals
├── id
├── task_id
├── status
└── timestamps

memory
├── id
├── mind_id
├── type
├── content
└── timestamps
```

---

# 11. Folder Structure

```text
minds/
│
├── apps/
│   ├── server/
│   │   └── src/
│   │       ├── server.ts
│   │       ├── routes/
│   │       └── webhooks/
│   │
│   └── cli/
│       └── src/
│
├── packages/
│   │
│   ├── runtime/
│   │   ├── mind-runtime.ts
│   │   ├── lifecycle.ts
│   │   ├── wake.ts
│   │   └── recovery.ts
│   │
│   ├── state/
│   │   ├── mind-state.ts
│   │   ├── state-machine.ts
│   │   └── transitions.ts
│   │
│   ├── tasks/
│   │   ├── task-engine.ts
│   │   ├── task-store.ts
│   │   └── task-types.ts
│   │
│   ├── events/
│   │   ├── event-bus.ts
│   │   ├── event-router.ts
│   │   └── event-types.ts
│   │
│   ├── memory/
│   │   ├── memory-store.ts
│   │   └── memory.ts
│   │
│   ├── providers/
│   │   ├── provider.ts
│   │   └── github-worker/
│   │       └── provider.ts
│   │
│   ├── github/
│   │   ├── client.ts
│   │   ├── webhooks.ts
│   │   └── events.ts
│   │
│   ├── approvals/
│   │   └── approval-service.ts
│   │
│   └── db/
│       ├── schema/
│       ├── migrations/
│       └── client.ts
│
├── minds/
│   └── repository/
│       ├── mind.yaml
│       ├── goals.yaml
│       └── instructions.md
│
├── docs/
│   ├── architecture.md
│   ├── lifecycle.md
│   └── provider.md
│
├── docker/
│   └── Dockerfile
│
├── package.json
├── bun.lock
├── tsconfig.json
└── PLAN.md
```

---

# 12. Mind Definition

The first Mind can be declarative.

```yaml
id: repository

name: Repository Mind

purpose: >
  Keep the configured GitHub repository healthy.

goals:
  - investigate CI failures
  - identify regressions
  - prepare fixes
  - ask for human approval when required

subscriptions:
  - github.ci.failed
  - github.pull_request.opened
  - user.message

capabilities:
  - github
  - repository
  - testing
```

The runtime loads this definition and creates the persistent Mind.

---

# 13. Phases

## Phase 0 — Runtime Spike

Goal:

> Prove the basic lifecycle.

Build:

```text
Mind
Task
Execution
State
Wake
Sleep
```

No GitHub yet.

Demo:

```text
event
 ↓
Mind wakes
 ↓
task created
 ↓
execution runs
 ↓
result persisted
 ↓
Mind sleeps
```

Use Bun for the runtime, package management, and scripts. Keep Phase 0 in-memory; do not introduce PostgreSQL or GitHub integration yet.

---

## Phase 1 — Durable Runtime

Introduce PostgreSQL.

Build:

- Mind registry
- Task persistence
- Event persistence
- Execution persistence
- State transitions
- Recovery
- Idempotency

Critical test:

```text
start
 ↓
create task
 ↓
kill server
 ↓
restart
 ↓
recover task
```

---

## Phase 2 — GitHub Integration

Add:

- GitHub authentication
- Webhooks
- Repository configuration
- CI failure events
- PR events
- GitHub API client

First real event:

```text
workflow_run.failed
```

---

## Phase 3 — Disposable Worker

Implement the first worker/provider.

```text
Minds
  ↓
Task
  ↓
GitHub Actions
  ↓
Worker
  ↓
Result
```

The worker must not contain Mind state.

It only receives a task and produces a result.

---

## Phase 4 — Human-in-the-Loop

Add:

```text
WAITING
```

Example:

```text
Mind investigates
      ↓
fix requires approval
      ↓
WAITING
      ↓
human approves
      ↓
WAKE
      ↓
continue execution
```

This proves that the Mind can maintain continuity across long periods of inactivity.

---

## Phase 5 — Memory

Start simple.

Store:

```text
facts
previous actions
important decisions
repository knowledge
task outcomes
```

Memory should be attached to the Mind, not the worker.

Do not introduce embeddings yet.

---

## Phase 6 — Scheduler / Wake Engine

Add non-event-based waking.

Examples:

```text
wake every morning
wake in 2 hours
wake when task deadline approaches
wake when dependency changes
```

The Mind becomes capable of both:

```text
event-driven wake
time-driven wake
```

---

## Phase 7 — Minimal Web UI

Build a dashboard showing:

```text
Minds
 └── Repository Mind
       ├── Current state
       ├── Current task
       ├── Recent events
       ├── Executions
       ├── Memory
       └── Pending approvals
```

The UI should make the Mind's lifecycle observable.

---

## Phase 8 — Multiple Minds

Only after the single-Mind runtime is stable.

Example:

```text
Minds
├── Repository Mind
├── Research Mind
└── Infrastructure Mind
```

Each Mind has:

```text
identity
purpose
goals
memory
subscriptions
state
```

The runtime remains shared.

---

## Phase 9 — Provider Ecosystem

Introduce additional execution providers.

```text
Provider
├── GitHub Worker
├── OpenCode
├── Codex
├── Claude
└── Custom Worker
```

The important property:

> Adding a provider must not require changing the Mind runtime.

---

# 14. Long-Term Architecture

Eventually:

```text
                         MINDS
                           │
                 ┌─────────┴─────────┐
                 │   Mind Runtime    │
                 └─────────┬─────────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
       Coding           Research          Ops
        Mind              Mind            Mind
          │                │                │
          └────────────────┼────────────────┘
                           │
                    Provider Router
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
     GitHub              Local             Other
     Worker              Worker            Worker
```

The runtime remains independent of any particular agent harness.

---

# 15. Guiding Principles

### 1. The Mind is not the worker

Workers are disposable.

### 2. State belongs to the Mind

Never rely on an agent session as the source of truth.

### 3. Everything important is durable

Events, tasks, state transitions and executions must survive restarts.

### 4. Sleeping is a first-class state

A Mind does not need an LLM running continuously.

### 5. Wake-up is event-driven

Something causes the Mind to act.

### 6. Human approval is part of the lifecycle

Waiting is not failure.

### 7. Providers are replaceable

The Mind should not care which agent executes its task.

### 8. Start with one Mind

Prove the runtime before building an ecosystem.

### 9. Avoid premature infrastructure

Do not introduce distributed systems, vector databases, Kubernetes or complex orchestration until the runtime requires them.

### 10. The fundamental abstraction

```text
Mind = Identity + State + Memory + Goals + Lifecycle
```

The worker is simply:

```text
Execution(Mind, Task)
```

---

# 16. MVP Definition in One Sentence

> **Minds MVP is a durable runtime that keeps a Repository Mind alive across events, executions, approvals, failures and process restarts, while delegating individual pieces of work to disposable workers.**
