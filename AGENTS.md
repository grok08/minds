# Repository instructions

Apply these instructions to all work in this repository. Follow the user's request and preserve existing user changes.

## Project facts

- Minds is a TypeScript runtime for a persistent Repository Mind. The Mind's state lives beyond any one task execution.
- `PLAN.md` defines the MVP goal, scope, and non-goals. Do not add a non-goal or expand the MVP unless the user asks.
- `progress.md` records implementation status, verified checks, and the next milestones. Read it with `PLAN.md` before planning project work, and update it when implementation status or verification changes.
- Use Bun 1.4.2. The project uses ESM, strict TypeScript, and `.ts` extensions in relative imports.
- `apps/cli` contains the demo entry point. `apps/server` contains the Fastify server.
- `packages/runtime` owns Mind lifecycle and task orchestration. `packages/github` owns GitHub event parsing, signature checks, and event mapping. `packages/db` owns PostgreSQL access and migrations.
- `tests/unit`, `tests/integration`, and `tests/manual` contain unit, integration, and manual checks.

## Make changes

- Before editing, find the code that owns the behavior and read its nearest tests and callers. Search before adding a new helper, type, dependency, or file.
- Keep each change within the owning package. Preserve existing public APIs and data flow unless the request requires a change.
- Keep business logic out of HTTP handlers and GitHub adapters. Keep GitHub-specific parsing and signature verification out of the runtime.
- Use parameterized SQL. Store credentials in environment variables. Never print, commit, or copy values from `.env` into source or output.
- For a database schema change, add a new numbered migration under `packages/db/migrations`. Do not rewrite an existing migration that may have run already.
- For bug fixes, reproduce the observed behavior and test the result a user can see. Avoid unrelated cleanup.
- For small, clear requests, make the change directly. For larger or ambiguous work, state the intended behavior and a short plan before editing. Ask a question only when a missing decision blocks a correct or safe change.

## Verify changes

- Run the narrowest relevant test after editing, then run `bun run tsc --noEmit` for TypeScript changes.
- Run `bun test` for the full suite only when its external prerequisites are available. Runtime tests need PostgreSQL. API server tests need PostgreSQL, a server listening on port 3000, and `GITHUB_WEBHOOK_SECRET`.
- `bun run test:integration` contacts GitHub and needs valid credentials and a configured test repository. Do not run it unless the task calls for live GitHub verification.
- `bun run db:init` initializes the database. `bun run db:migrate` applies migrations. Do not run either against a database unless the user or task identifies it as safe to modify.
- If a check cannot run, state the missing prerequisite. Do not claim a check passed unless you ran it and saw it pass.

## Report results

- Keep the final response concise. State what changed, which checks ran, and any remaining blocker or unverified behavior.
- Give conclusions supported by the files, test output, or commands you actually inspected. Mark assumptions as assumptions.
- Do not provide hidden chain-of-thought. Give a short rationale or evidence summary when it helps the user assess the result.