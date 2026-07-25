# Workspace domain refactor implementation plan

**Spec:** `docs/superpowers/specs/2026-07-25-workspace-domain-refactor-design.md`

## Task 1: Contract inventory and RED tests

- Record every database, API, SDK, CLI, web, and mobile project surface.
- Add failing tests for canonical workspace routes and exports.
- Add compatibility tests for deprecated project boundaries.

## Task 2: Database domain

- Add one forward migration for workspace tables, columns, and database objects.
- Rename Drizzle schema exports and relations.
- Preserve existing identifiers and relationships.
- Run migrations and database tests against the isolated database.

## Task 3: API domain

- Rename the internal domain to `workspaces`.
- Mount canonical `/workspaces` handlers.
- Mount deprecated `/projects` aliases over the same handlers.
- Use canonical workspace request and response fields.
- Regenerate the route manifest.

## Task 4: SDK domain

- Add canonical workspace types, functions, React hooks, and facade methods.
- Call canonical `/workspaces` routes.
- Keep every existing project export as a deprecated alias.
- Run the public-export snapshot and all SDK release gates.

## Task 5: CLI domain

- Add canonical `kortix workspaces` commands and help.
- Keep `kortix projects` as a deprecated delegating alias.
- Run both command families as real processes.

## Task 6: Web domain and default routing

- Move canonical routes to `/workspaces`.
- Add `/projects` compatibility redirects.
- Rename symbols, copy, analytics, and visible labels.
- Route login and organization switching to the default workspace.
- Hide the switcher for one workspace.
- Keep explicit workspace management under organization settings.
- Verify DOM state and network requests in Chromium.

## Task 7: Mobile, tests, and documentation

- Move mobile routes and symbols to workspaces.
- Rename test fixtures and documentation.
- Preserve compatibility examples where required.
- Run mobile and documentation checks.

## Task 8: Full local verification

- Run focused and full database, API, SDK, CLI, web, mobile, and `ke2e` gates.
- Exercise canonical and compatibility behavior with real inputs.
- Fix all regressions.

## Task 9: Pull request

- Rebase on current `origin/main`.
- Push the branch.
- Open a pull request against `main`.
- Wait for every required check.
- Resolve all failures and review findings.
- Stop before merge for user approval.
