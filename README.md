# Minds

Minds is a runtime for building persistent autonomous entities called Minds. A Mind has an identity, purpose, goals, durable state, memory, event subscriptions, tasks, and a lifecycle. It can wake for an event, act, wait for input, resume later, and sleep when it has no work.

The Mind persists beyond any one task or worker execution. Workers are disposable and perform work on the Mind's behalf. Minds is not tied to GitHub or to a particular agent engine.

## First MVP

The first MVP uses one Repository Mind whose purpose is to keep a GitHub repository healthy. GitHub is the first external environment, not the definition of a Mind. The MVP tests whether a persistent Mind can react to events, execute durable tasks, wait for approval, resume, preserve its history, and recover after the runtime restarts.

The current prototype stores runtime data in PostgreSQL. Phase 3, the disposable GitHub Actions worker, and Phase 4, durable human approval and resume, are implemented and locally verified. A live GitHub Actions approval round trip remains unverified, so the MVP is not complete. See [progress.md](progress.md) for current status and verification results.

## Mind and worker responsibilities

The planned architecture keeps durable responsibilities in Minds:

- Identity, purpose, goals, and current state
- Memory, event subscriptions, and lifecycle
- Tasks, approvals, execution history, and recovery
- Choosing a provider for a task

Workers perform task execution, such as interacting with an agent engine, tools, shell commands, or a repository. A worker may disappear without losing the Mind's identity or persisted state. The current code has mock and GitHub Actions providers.

## Current GitHub flow

For the first MVP, the implemented worker path is:

1. GitHub sends a signed webhook to the Minds server.
2. The runtime stores the event and creates a task for the Repository Mind.
3. The GitHub worker provider dispatches a workflow in the configured repository.
4. The worker registers its workflow run ID and reports its result to the server.
5. The runtime stores the result and returns the Mind to sleep.

To submit a user message, send `POST /messages` with a non-empty `message`. Set `requiresApproval` to `true` when the worker must wait for a human decision. The worker reports its approval request to the runtime. The runtime persists the request and leaves the Mind in `waiting`. `POST /tasks/:id/approve` dispatches a new worker execution with the saved continuation context. `POST /tasks/:id/reject` records a terminal rejection.

The prototype API does not authenticate user message or approval requests. Do not expose these routes to untrusted networks.

## Repository layout

- `apps/cli` contains the mock-provider demo.
- `apps/server` contains the Fastify server.
- `packages/runtime` owns the Mind lifecycle, task orchestration, polling, and recovery.
- `packages/github` verifies and maps GitHub webhook events.
- `packages/providers` contains the mock and GitHub Actions worker providers.
- `packages/db` contains the PostgreSQL client, migrations, and database scripts.
- `tests/unit`, `tests/integration`, and `tests/manual` contain the test suites.
- `.github/workflows/minds-worker.yml` contains the disposable worker workflow.

## Requirements

- Bun 1.4.2
- PostgreSQL
- A GitHub repository for webhook events and workflow dispatch
- A GitHub token with access to that repository and permission to dispatch workflows

## Configure

Create a `.env` file in the repository root. Do not commit this file.

```dotenv
DB_HOST=localhost
DB_PORT=5432
DB_NAME=minds
DB_USER=postgres
DB_PASSWORD=

GITHUB_OWNER=your-owner
GITHUB_REPO=your-repository
GITHUB_TOKEN=your-token
GITHUB_WEBHOOK_SECRET=your-webhook-secret
MINDS_CALLBACK_SECRET=your-callback-secret
MINDS_SERVER_URL=https://your-public-server-url

PORT=3000
MIND_ID=repository
NGROK_URL=https://your-public-server-url
```

The server requires `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_WEBHOOK_SECRET`, and `MINDS_CALLBACK_SECRET`. Set `GITHUB_TOKEN` to dispatch worker workflows and call the GitHub API. GitHub Actions must be able to reach `MINDS_SERVER_URL` to register run IDs and report results. The integration test uses `NGROK_URL` as the public server URL.

The database settings default to `localhost:5432`, database `minds`, user `postgres`, and an empty password. `PORT` defaults to `3000`, and `MIND_ID` defaults to `repository`.

In the configured GitHub repository, add the worker workflow from `.github/workflows/minds-worker.yml` and set the repository secret `MINDS_CALLBACK_SECRET`. Configure a webhook that sends `workflow_run` and `pull_request` events to `https://your-public-server-url/events`, using the same value as `GITHUB_WEBHOOK_SECRET`.

## Set up PostgreSQL

Create a PostgreSQL database named `minds`, then run:

```sh
bun install --frozen-lockfile
bun run db:init
bun run db:migrate
```

`db:init` reads the `DB_*` variables. The current `db:migrate` script connects to `localhost:5432`, database `minds`, as `postgres` with an empty password. Configure PostgreSQL to match those defaults before running it.

## Run the server or demo

Start the HTTP server:

```sh
bun run server
```

The health endpoint is `GET /health`. The server listens on port `3000` by default.

Run the mock-provider demo:

```sh
bun run start
```

Both commands require a working PostgreSQL database. The server also requires the GitHub and callback settings listed above.

## Run checks

Run the unit tests, server recovery integration test, and TypeScript check:

```sh
bun test tests/unit/
bun test tests/integration/server-restart.test.ts
bun run tsc --noEmit
```

The GitHub integration commands contact and modify the configured repository. Use a disposable repository and valid credentials before running them:

```sh
bun run test:phase3
bun run test:integration
```

`test:phase3` runs the worker, PR, idempotency, and failure-callback scenarios. The full integration command also runs the broader GitHub integration suite. Both need PostgreSQL, a running server, a public callback URL, and the required GitHub settings.

## Security and limitations

The repository table currently stores the GitHub token and webhook secret in PostgreSQL. Do not use production credentials with this prototype. Define protected credential storage before deploying Minds for production use.

The runtime currently initializes one Repository Mind. Durable approval and resume behavior, structured memory operations, scheduling, and a user interface are not complete. See [PLAN.md](PLAN.md) for MVP scope and [progress.md](progress.md) for implementation details.