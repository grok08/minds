# Project progress

Status snapshot: 2026-10-04

Minds is an early prototype. The current code covers the lifecycle, durable storage, core GitHub event path, a disposable GitHub Actions worker with polling and timeout recovery, and human-in-the-loop approval workflow. The MVP in `PLAN.md` is not complete.

## Completed

- Reorganized the code into `apps/`, `packages/`, and `tests/`. Updated imports, package scripts, TypeScript includes, and migration paths.
- Implemented a PostgreSQL-backed Repository Mind runtime that stores Minds, events, tasks, executions, state transitions, and results.
- Added duplicate-event handling and transactional startup recovery for incomplete tasks. Recovery fails the interrupted task and execution, marks the event processed, and returns the Mind to `sleeping`.
- Fixed runtime snapshots to select execution columns explicitly, preventing joined task columns from overwriting execution IDs and statuses.
- Made the server Mind ID configurable through `MIND_ID` for isolated runtime tests. The default remains `repository`.
- Added GitHub webhook parsing, raw-body signature verification, repository filtering, and mapping for CI failure and opened pull request events.
- Added a Fastify server with health, Mind, task, event, and approval routes.
- Added an Octokit client for workflow-run and pull-request operations.
- Added unit, database-backed runtime, API, manual, and live GitHub integration checks.
- Added root `AGENTS.md` guidance for repository scope, architecture, and verification.
- **Phase 3: Implemented and verified the disposable GitHub Actions worker with robust polling and timeout recovery.**
  - Created `.github/workflows/minds-worker.yml` workflow that executes outside the Minds server process.
  - Updated `GitHubWorkerProvider` to dispatch workflow via `workflow_dispatch` API instead of running Octokit calls synchronously.
  - Added `workflow_run_id` column to executions table (migration 002).
  - Added callback endpoint `/executions/:executionId/started` for worker to register GitHub run ID (`GITHUB_RUN_ID`) at startup.
  - Added callback endpoint `/executions/:executionId/result` for worker to report results (requires non-empty result for completed status).
  - Added `pollExecutions()` method in runtime for polling workflow status.
  - Runtime handles both sync (mock) and async (GitHub Actions) provider completions.
  - **Added execution polling into server lifecycle**: `startPolling()` called after initialization, `stopPolling()` on graceful shutdown (SIGTERM/SIGINT). Single-flight guard prevents overlapping poll cycles; shutdown drains in-flight poll before closing database.
  - **Added timeout recovery**: `pollExecutions()` detects executions running past configurable `timeoutMs` (default 5 min) based on `startedAt` for ALL running executions (with or without run ID). Calls `provider.stop()` best-effort when run ID available, but persists failure regardless of cancellation success.
  - **Added grace period for callback registration**: Executions without a run ID are given a configurable `callbackGracePeriodMs` (default 2 min) before failing with a clear missing-run-ID error.
  - **Corrected polling outcomes**: A workflow's successful conclusion without a recorded worker result fails the task with a clear "missing worker result" error instead of marking it successful with an empty result.
  - **Routed polled terminal states through `recordExecutionResult()`**: Uses the same transactional, idempotent path as callbacks. Duplicate polls no-op; races with callbacks are prevented by `FOR UPDATE` row locks and status checks.
  - **Handles transient GitHub API errors**: Polling errors from `provider.status()` are logged as warnings without failing the execution.
  - **Added deterministic unit tests**: Poll processes terminal workflow status (completed/failed) idempotently; timeout triggers `stop()` and records failure with error message; grace period expiry fails missing run ID; missing worker result on completion fails with clear error; worker failure callback leaves Mind able to accept next event; single-flight polling verified.
- **Phase 4: Implemented Human-in-the-Loop approval workflow.**
  - Added `POST /messages` to create durable `user.message` tasks, with boundary validation for the message and approval flag.
  - Added an authenticated worker callback `/executions/:executionId/approval` that records a pending approval and moves the task and Mind to `waiting`.
  - The worker can return an `approval_required` outcome for a user message that requires approval. The runtime stores the continuation payload and marks the finished worker execution complete.
  - Approval decisions are transactional and idempotent. Approval creates a new execution and dispatches the original task with its persisted approval context after the transaction commits.
  - Rejection records a terminal task failure. The worker execution has already ended when the request is accepted, so rejection leaves no active execution.
  - Updated `/tasks/:id/approve` and `/tasks/:id/reject` to call runtime methods. Invalid state transitions return conflict responses.
  - Added task approval payload/timestamp fields and approval decision/continuation fields in migration 003.
  - Startup recovery keeps a task and Mind in `waiting` while a pending approval exists. Approval after restart resumes the task.
  - Added tests for worker approval requests and continuation, callback retries, approval/rejection idempotency, invalid transitions, and restart-and-resume behavior.

## Verification

- 2026-10-04: After Phase 4 changes, `bun run tsc --noEmit`, `git diff --check`, and `bun test tests/unit/` passed. The 41 unit tests ran across 4 files. Runtime tests used a temporary isolated PostgreSQL database with migrations 001-003 applied; the database was removed after each run.
- 2026-10-04: `bun test tests/integration/server-restart.test.ts` passed. Started server, persisted running work under unique Mind ID, killed server process, restarted it, verified recovered Mind, task, execution, and event state.
- 2026-10-04: `git diff --check` passed.
- Phase 4 unit tests cover: approval request → waiting → approval → continuation → completion; rejection; invalid transitions; idempotency; restart recovery preserving waiting tasks; duplicate approval/rejection idempotency.
- The Phase 4 unit run did not dispatch a live GitHub Actions worker or exercise an externally hosted callback. The callback, workflow inputs, and worker behavior were covered by local tests.
- Not rerun in this snapshot: API server tests or the live GitHub integration script. Port 3000 was already in use, so the existing server was left untouched. API tests also need a configured server and webhook secret; live GitHub tests need an authorized disposable test repository.
- Historical live GitHub integration: the user reports that the configured repository was used and the integration tests were run. The date and pass/fail output are not recorded in the available project notes or session history, so this is not counted as a fresh verified run.
- 2026-10-04: A user-provided GitHub settings screenshot shows a webhook configured for `aichemy/minds-test-repo`, subscribed to pull request, push, and workflow events. GitHub reports that its last delivery was successful. The screenshot does not show the delivery details or confirm the corresponding persisted event and task.
- 2026-10-04: `bun run verify:webhook-correlation` matched GitHub delivery `2cab2f60-bfb8-11f1-8bea-40e7bb83d47b` (`workflow_run.completed`, HTTP 200) to processed event `github.ci.failed`, completed task `task-1791093315988-kfnmpri`, and completed execution `execution-1791093315989-z58x88v` in PostgreSQL.

## Current gaps

- Phase 0's basic lifecycle is demonstrated, but the demo uses PostgreSQL. The plan specifies an in-memory spike.
- Phase 1 persists lifecycle data and detects incomplete tasks. Startup recovery atomically marks interrupted events, tasks, and executions terminal, then returns the Mind to `sleeping` so it can accept new events. The PostgreSQL runtime tests and server process kill-and-restart test pass. The server test seeds persisted running state while the process is alive; it does not interrupt an executing worker. The recovery scenario in `tests/integration/github.integration.ts` edits database rows directly and does not kill or restart the server.
- Phase 2 has webhook handling, repository configuration, event mapping, and GitHub API calls. `tests/integration/github.integration.ts` covers CI failure, PR-opened processing, and duplicate-delivery idempotency by posting signed webhook payloads directly to the server. It creates or updates a real workflow and pull request through GitHub's API, but those webhook payloads are simulated rather than captured from GitHub delivery records. `bun run verify:webhook-correlation` separately verified one actual `workflow_run.completed` delivery through event, task, and execution persistence.
- Phase 4 is implemented and locally verified. The local tests cover the worker request/continuation protocol and durable runtime lifecycle. A live GitHub Actions approval round trip remains unverified.
- Phase 5 is not implemented beyond the database table. There is no memory read/write behavior in the runtime.
- Phase 6 has no timer or scheduler.
- Phase 7 has no web UI.
- Phase 8 is not implemented. The runtime accepts a Mind ID, but the server initializes only the hard-coded `repository` Mind.
- Phase 9 has no replaceable provider ecosystem.
- The repository table stores the GitHub token and webhook secret. Define protected credential storage before production use.

## Next milestones

Complete these in order. Keep later phases out of scope until their prerequisites work.

1. **Maintain Phase 2 verification.** Keep the existing PR-opened and duplicate-delivery integration scenarios. The real webhook correlation command can also confirm an actual PR delivery when one exists in GitHub's delivery history. Rerun the full GitHub integration script only when its side effects are authorized and the configured repository is disposable.
2. **Phase 4 is complete and locally verified.** Human-in-the-loop approval workflow has durable waiting state, atomic approval/rejection, continuation execution, and restart recovery. A live GitHub Actions approval round trip remains unverified.
3. **Implement Phase 5.** Add structured, Mind-owned memory operations and tests for persistence across runtime restarts.
4. **Implement Phase 6.** Add scheduled wake-ups only after event-driven wake and recovery work reliably.
5. **Implement Phase 7.** Add the minimal observability and control UI described in `PLAN.md`.
6. **Consider Phases 8 and 9.** Add multiple Minds and providers only after the single-Mind runtime and first worker are stable.

## Engineering standards

- Treat `PLAN.md` as the product scope and this file as the current status. Record progress only when code or test evidence supports it.
- Keep each change within its owning package. Read the implementation, its callers, and the closest tests before editing.
- Test user-visible behavior. Prefer a focused test for the changed path, then run `bun run tsc --noEmit` for TypeScript changes.
- Use `bun test` only with an isolated PostgreSQL database, a running server for API tests, and the required webhook secret. Runtime tests delete rows for their fixed test Mind ID.
- `bun run test:integration` changes a GitHub test repository by creating or updating a failing workflow and pull request. Run it only with explicit authorization and a disposable test repository.
- Add a new numbered migration under `packages/db/migrations` for schema changes. Do not edit migrations that may already have run.
- Use parameterized SQL. Validate external data at system boundaries. Keep GitHub parsing in `packages/github` and lifecycle decisions in `packages/runtime`.
- Protect tokens and webhook secrets. Never print or commit `.env` values. Do not add persistent plaintext credential storage without an explicit security design.
- Do not run database initialization, migration, reset, or destructive test commands against an unidentified database.
- Report exactly which checks ran and passed. State unavailable prerequisites and unverified behavior plainly.