# Workspace domain refactor

**Date:** 2026-07-25

**Status:** Approved by direct user request

## Objective

Replace the Kortix `Project` domain with the canonical `Workspace` domain.

Use this hierarchy:

```text
Account
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

- Each account owns one or more workspaces.
- A new account receives one default workspace.
- The default workspace name matches the account name.
- Login opens the current account's default workspace.
- Account switching opens that account's default workspace.
- The interface hides the workspace switcher for one accessible workspace.
- The interface shows the switcher for two or more accessible workspaces.
- Workspace creation remains an explicit account-management action.
- The zero-workspace state appears only when automatic creation fails.

## Canonical names

The canonical domain uses these names:

- Public storage term: `Workspace`.
- API collection: `/v1/workspaces`.
- SDK facade: `kortix.workspace(workspaceId)`.
- SDK collection: `kortix.workspaces`.
- CLI noun: `kortix workspaces`.
- Web route: `/workspaces/:workspaceId`.
- Mobile route: `/workspaces/:workspaceId`.
- Public types and functions use `Workspace`.

Physical database identifiers remain `projects`, `project_*`, and `project_id`
in this change. They are compatibility storage details, not public product names.

## Compatibility

Existing identifiers remain unchanged.

The following deprecated boundaries remain:

- `/v1/projects/*` serves the same handlers as `/v1/workspaces/*`.
- `/projects/*` redirects to the matching `/workspaces/*` route.
- `kortix projects` delegates to `kortix workspaces`.
- Published SDK `Project` exports alias their `Workspace` replacements.
- `kortix.project(projectId)` delegates to `kortix.workspace(workspaceId)`.

Compatibility aliases must not create a second implementation.

## Storage compatibility

This change does not rename physical database objects.

- `kortix.projects` remains the storage table.
- `project_*` tables remain unchanged.
- `project_id` columns remain unchanged.
- Existing indexes, constraints, policies, functions, and triggers remain unchanged.

The API and SDK map this storage model onto the canonical Workspace contract.
This boundary avoids a high-risk database migration during the terminology cutover.

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

Web and mobile use Workspace copy, analytics, and canonical route segments.

Internal compatibility modules can retain Project symbols while they delegate to
the canonical Workspace surface.

Compatibility route files only redirect.

The web project catalog becomes a default-workspace resolver.

Workspace management remains available under organization settings.

## Non-goals

- Rename `Account` to another domain in this change.
- Change existing UUID values.
- Remove deprecated project compatibility.
- Merge the pull request without user approval.
- Deploy before merge.

## Verification

The change requires:

- Storage compatibility tests with no schema migration.
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
