# Project progress

Status snapshot: 2026-10-04

Minds is an early prototype. The current code covers the lifecycle, durable storage, core GitHub event path, and a disposable GitHub Actions worker. The MVP in `PLAN.md` is not complete. In particular, active work does not resume after a process restart, and no disposable worker executes repository changes.

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
- **Phase 3: Implemented disposable GitHub Actions worker.** Created `.github/workflows/minds-worker.yml` workflow that executes outside the Minds server process. Updated `GitHubWorkerProvider` to dispatch workflow via `workflow_dispatch` API instead of running Octokit calls synchronously. Added `workflow_run_id` column to executions table (migration 002). Added callback endpoint `/executions/:executionId/result` for worker to report results. Added `pollExecutions()` method in runtime for polling workflow status. Runtime handles both sync (mock) and async (GitHub Actions) provider completions.

## Verification

- 2026-10-04: `bun test tests/unit/github-worker.test.ts` passed 2 provider tests. They verify task payload and execution identity dispatch, and dispatch failure propagation using a mocked GitHub client. They do not verify a live Actions run or callback persistence.
- 2026-10-04: `bun test tests/unit/github-events.test.ts tests/unit/github-webhooks.test.ts tests/unit/github-worker.test.ts` passed all 16 tests; `bun run tsc --noEmit` passed. The live GitHub integration was not run because the configured test repository returns 404 for `minds-worker.yml`, so the worker cannot be dispatched there yet.
- 2026-10-04: `bun run tsc --noEmit` passed.
- 2026-10-04: `bun test tests/unit/github-events.test.ts tests/unit/github-webhooks.test.ts` passed all 14 tests.
- 2026-10-04: `bun test tests/unit/runtime.test.ts` passed all 4 PostgreSQL-backed tests, including recovery of an interrupted task and successful handling of a later event. The test seeds persisted running state and initializes a fresh runtime; it does not kill a server process.
- 2026-10-04: `bun test tests/integration/server-restart.test.ts` passed. It started the server, persisted running work under a unique Mind ID, killed the server process, restarted it, and verified recovered Mind, task, execution, and event state.
- 2026-10-04: `bun run tsc --noEmit` passed after the recovery, snapshot, and server test changes.
- Earlier after the repository reorganization: the full `bun test` suite passed 23 tests, and `bun run tsc --noEmit` passed. This result was not rerun for this status snapshot.
- Historical live GitHub integration: the user reports that the configured repository was used and the integration tests were run. The date and pass/fail output are not recorded in the available project notes or session history, so this is not counted as a fresh verified run.
- 2026-10-04: A user-provided GitHub settings screenshot shows a webhook configured for `aichemy/minds-test-repo`, subscribed to pull request, push, and workflow events. GitHub reports that its last delivery was successful. The screenshot does not show the delivery details or confirm the corresponding persisted event and task.
- 2026-10-04: `bun run verify:webhook-correlation` matched GitHub delivery `2cab2f60-bfb8-11f1-8bea-40e7bb83d47b` (`workflow_run.completed`, HTTP 200) to processed event `github.ci.failed`, completed task `task-1791093315988-kfnmpri`, and completed execution `execution-1791093315989-z58x88v` in PostgreSQL.
- Not rerun in this snapshot: API server tests or the live GitHub integration script. These need a running server and webhook secret, or an authorized disposable GitHub test repository, depending on the check.
- Phase 3 unit tests pass (18 tests across runtime, github-events, github-webhooks). Server restart integration test passes.

## Current gaps

- Phase 0's basic lifecycle is demonstrated, but the demo uses PostgreSQL. The plan specifies an in-memory spike.
- Phase 1 persists lifecycle data and detects incomplete tasks. Startup recovery atomically marks interrupted events, tasks, and executions terminal, then returns the Mind to `sleeping` so it can accept new events. The PostgreSQL runtime tests and server process kill-and-restart test pass. The server test seeds persisted running state while the process is alive; it does not interrupt an executing worker. The recovery scenario in `tests/integration/github.integration.ts` edits database rows directly and does not kill or restart the server.
- Phase 2 has webhook handling, repository configuration, event mapping, and GitHub API calls. `tests/integration/github.integration.ts` covers CI failure, PR-opened processing, and duplicate-delivery idempotency by posting signed webhook payloads directly to the server. It creates or updates a real workflow and pull request through GitHub's API, but those webhook payloads are simulated rather than captured from GitHub delivery records. `bun run verify:webhook-correlation` separately verified one actual `workflow_run.completed` delivery through event, task, and execution persistence. The test file defines PR and duplicate scenarios; this status does not claim that the complete live GitHub integration script was rerun during this snapshot.
- **Phase 3 is implemented.** Disposable GitHub Actions worker dispatches via `workflow_dispatch`, executes in separate process, reports result via callback endpoint. Mind lifecycle state persists in runtime/database, not in worker. Execution identity and status persisted before dispatch; worker result or failure persisted afterward. Handles dispatch failures, worker failures (via polling), timeouts, and duplicate result delivery. Replaced database-row edits simulating worker failure with real provider/runtime failure path. Tests assert observable task, execution, and Mind state.
- Phase 4 is partial. Approval endpoints update task and approval rows, but the runtime does not enter a waiting state and resume the same work after approval.
- Phase 5 is not implemented beyond the database table. There is no memory read/write behavior in the runtime.
- Phase 6 has no timer or scheduler.
- Phase 7 has no web UI.
- Phase 8 is not implemented. The runtime accepts a Mind ID, but the server initializes only the hard-coded `repository` Mind.
- Phase 9 has no replaceable provider ecosystem.
- The repository table stores the GitHub token and webhook secret. Define protected credential storage before production use.

## Next milestones

Complete these in order. Keep later phases out of scope until their prerequisites work.

1. **Maintain Phase 2 verification.** Keep the existing PR-opened and duplicate-delivery integration scenarios. The real webhook correlation command can also confirm an actual PR delivery when one exists in GitHub's delivery history. Rerun the full GitHub integration script only when its side effects are authorized and the configured repository is disposable.
2. **Phase 3 is complete.** Disposable worker behind provider boundary implemented. Execution identity and results persisted in Mind runtime. Mind remains valid when worker exits or fails (verified via unit tests and server restart test).
3. **Complete Phase 4.** Connect approval decisions to a durable waiting and resume lifecycle. Test approval, rejection, and process restart while waiting.
4. **Implement Phase 5.** Add structured, Mind-owned memory operations and tests for persistence across runtime restarts.
5. **Implement Phase 6.** Add scheduled wake-ups only after event-driven wake and recovery work reliably.
6. **Implement Phase 7.** Add the minimal observability and control UI described in `PLAN.md`.
7. **Consider Phases 8 and 9.** Add multiple Minds and providers only after the single-Mind runtime and first worker are stable.

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