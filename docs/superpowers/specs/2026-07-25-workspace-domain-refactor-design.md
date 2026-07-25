# Workspace domain refactor

**Date:** 2026-07-25

**Status:** Approved by direct user request

## Objective

Replace the Kortix `Project` domain with the canonical `Workspace` domain.

Use this hierarchy:

```text
Organization
└── Workspace
    ├── Agents
    ├── Sessions
    ├── Memory
    ├── Repositories
    ├── Connectors
    ├── Secrets
    └── Policies
```

Keep deprecated compatibility boundaries for existing consumers.

## Product contract

- Each organization owns one or more workspaces.
- A new organization receives one default workspace.
- The default workspace name matches the organization name.
- Login opens the current organization's default workspace.
- Organization switching opens that organization's default workspace.
- The interface hides the workspace switcher for one accessible workspace.
- The interface shows the switcher for two or more accessible workspaces.
- Workspace creation remains an explicit organization-management action.
- The zero-workspace state appears only when automatic creation fails.

## Canonical names

The canonical domain uses these names:

- Database table: `workspaces`.
- Database foreign key: `workspace_id`.
- API collection: `/v1/workspaces`.
- SDK facade: `kortix.workspace(workspaceId)`.
- SDK collection: `kortix.workspaces`.
- CLI noun: `kortix workspaces`.
- Web route: `/workspaces/:workspaceId`.
- Mobile route: `/workspaces/:workspaceId`.
- Public types and functions use `Workspace`.

Project-scoped child records use `workspace_` names.

## Compatibility

Existing identifiers remain unchanged.

The following deprecated boundaries remain:

- `/v1/projects/*` serves the same handlers as `/v1/workspaces/*`.
- `/projects/*` redirects to the matching `/workspaces/*` route.
- `kortix projects` delegates to `kortix workspaces`.
- Published SDK `Project` exports alias their `Workspace` replacements.
- `kortix.project(projectId)` delegates to `kortix.workspace(workspaceId)`.

Compatibility aliases must not create a second implementation.

## Database migration

One forward migration renames:

- `kortix.projects` to `kortix.workspaces`.
- Every `kortix.project_*` table to its `kortix.workspace_*` equivalent.
- Every domain foreign-key column from `project_id` to `workspace_id`.
- Project-named indexes, constraints, policies, functions, and triggers.

The migration preserves row identifiers and relationships.

Application code uses only canonical workspace database names after migration.

## API

The API mounts canonical handlers under `/workspaces`.

The deprecated `/projects` router mounts the same handlers.

Canonical request and response fields use `workspace_id`.

Deprecated project routes preserve legacy response fields when required.

The route manifest and black-box contract list both route families.

## SDK

The SDK adds a canonical `workspaces-client` module and root exports.

The canonical client calls `/workspaces`.

Deprecated project functions delegate to canonical workspace functions.

The public export change is additive.

No existing export disappears.

The package version remains unchanged.

## Applications

Web and mobile code use workspace route segments, symbols, copy, and analytics.

Compatibility route files only redirect.

The web project catalog becomes a default-workspace resolver.

Workspace management remains available under organization settings.

## Non-goals

- Rename `Account` to `Organization` in this change.
- Change existing UUID values.
- Remove deprecated project compatibility.
- Merge the pull request without user approval.
- Deploy before merge.

## Verification

The change requires:

- Database migration and schema tests on the isolated database.
- Canonical and deprecated API black-box requests.
- SDK RED tests and all SDK release gates.
- Real CLI process tests for both nouns.
- Browser assertions for routing, network requests, and switcher states.
- Mobile typecheck and route tests.
- Route-manifest and `ke2e` coverage checks.
- All required pull-request checks.

## Completion condition

The pull request is ready when every required check passes.

The pull request remains unmerged for user approval.
