---
recorded: 2026-09-26T14:46:52Z
incident_date: 2026-09-26
---
# Derive app availability from the auth broker, and pass the operator's auth config when the broker asks for one

**Rule:** Decide whether an app can connect from the broker's own metadata
(`no_auth`, `auth_schemes`, `composio_managed_auth_schemes`) plus the enabled
auth configs, and hide an app that cannot connect. When the broker refuses a
session because an auth config is missing, look up the operator's enabled
config and pass it explicitly. Never show the broker's raw error body as the
user's message.

**Trigger surface:** Listing, adding, syncing, or connecting any app through a managed
auth broker (Composio Tool Router, Pipedream): `apps/api/src/connectors/composio*.ts`,
the Connectors catalogue, and connector sync.

**Incident:** 2026-09-26 prod, reported by a user: adding X failed with Composio's raw
`400 code 4300 "require auth configs but none exist and cannot be auto-created"`.
Composio removed its managed X app on 2026-02-12; 47 OAuth-only toolkits have no
managed app. Kortix left `authConfigs` unset on every session, and Tool Router
never picks up a custom config by itself (verified live), so these toolkits could
not sync on dev, staging, or prod even after an operator configured one. The
catalogue still listed all 47 as addable. PR #7736.

**Enforcement:** `composio-catalog-search.test.ts` (classification, hiding,
fail-open), `composio.test.ts` (4300 retry with the operator config, typed `422
composio_auth_config_required`, other refusals untouched), and `CONN-24` "listed
only when its declaration syncs" on the staging release gate.">
