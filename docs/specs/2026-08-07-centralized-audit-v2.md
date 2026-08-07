# Centralized audit v2

## Problem

`kortix.audit_events` is the only account audit API, but it is not the complete
system history. Session actions remain split across Connector, lifecycle,
trigger, provider, gateway, usage, voice, tunnel, and OpenCode stores. The
session audit route reads only `connector_calls`. Human request provenance also
trusts the public `X-Kortix-Client` header.

The result cannot reconstruct one session in order. It also loses webhook
deliveries, silently ignores malformed time and cursor filters, and caps exports
at 10,000 rows without a continuation contract.

## Required contract

One canonical audit event contains:

- `account_id`, `project_id`, `session_id`, and `opencode_session_id`.
- `turn_id`, `message_id`, `tool_call_id`, and `execution_id`.
- A monotonic `session_sequence` for stable reconstruction.
- Actor, agent, initiator, parent, and delegation identity.
- `authoritative_source` and the separate untrusted `client_reported_source`.
- `action`, `phase`, and `outcome`.
- Request, trace, correlation, causation, and parent-event identifiers.
- Source-ledger name, source record, and source revision.
- Redacted input/output summaries plus SHA-256 digests.
- Error, duration, and integrity-chain fields.

The existing `source` field remains compatible. It mirrors
`authoritative_source` for new events.

## Durability

1. Existing durable ledgers project into `audit_events` in the same database
   transaction through idempotent database triggers.
2. External effects have a durable `started` or `pending` source row before the
   effect and a terminal source-row update after it.
3. OpenCode events enter through an authenticated idempotent batch endpoint.
4. The database allocates `session_sequence`. Concurrent writers cannot produce
   duplicate sequence numbers.
5. `audit_events` rejects update and delete operations. Maintenance requires an
   explicit transaction-local override.
6. Account deletion does not rewrite or delete canonical events.
7. Webhook delivery uses a durable delivery ledger with retry scheduling,
   terminal dead-letter state, and manual replay.
8. A continuous reconciler revisits every account and projects any missing
   source-ledger phase. The initial completion marker does not disable later
   drift detection.

### Durability boundary

The nine source-ledger projections are the authoritative durability path. Their
database triggers run in the same transaction as each source-row insert or
update. A canonical audit insert failure aborts that source transaction.

The generic HTTP request envelope runs after a route completes. It adds reads
and route-level context, but it cannot roll back an arbitrary mutation that did
not use a source ledger or `runAuditedTransaction`. Its write failure is logged.
New security-relevant mutations must use a durable source ledger or
`runAuditedTransaction`; the generic envelope is not a substitute.

## Runtime capture

The sandbox agent already owns the authenticated OpenCode `/event` SSE loop.
That loop captures every event, including sub-agent sessions. It batches the
events to the API with stable event identifiers.

The sanitizer records event type, identifiers, tool name, paths, sizes, status,
and bounded redacted summaries. It replaces credential-shaped fields and values.
It hashes canonical raw input and output before discarding the raw values.

Captured actions include prompts, messages, tool transitions, terminal/PTTY,
file events, browser and MCP tools, permissions, questions, sub-agent sessions,
idle, abort, and error transitions.

## Query surfaces

- Account API: cursor-paginated canonical events with strict filters.
- Project API: the same event shape filtered by `project_id`.
- Session API: the same event shape ordered by `session_sequence`.
- Export API: resumable CSV and JSONL pages with `next_cursor` and `complete`.
- SDK: one framework-free typed contract for all three scopes.
- CLI: `audit ls`, `audit project`, `audit session`, and resumable `audit export`.
- Web: account and session views use the SDK contract and expose the same filters.

Malformed timestamps, limits, UUIDs, and cursors return HTTP 400. No filter fails
open.

Timestamp cursors resolve the immutable cursor event before comparison. The
database keeps microseconds while JavaScript exposes milliseconds, so direct
timestamp comparison can repeat the boundary event and stall an export.

## Security and privacy

- Authentication determines `authoritative_source`.
- `X-Kortix-Client` populates only `client_reported_source`.
- Agent and sandbox credentials bind project and session scope server-side.
- Request bodies, prompt bodies, environment values, credentials, and raw tool
  outputs never enter canonical audit fields.
- Redaction tests cover common tokens, authorization headers, URLs, and nested
  values.

## Verification

- Database migration, append-only, deletion, idempotency, sequencing, and
  reconciliation tests.
- API validation, auth scope, pagination, export-resume, and failure-injection
  tests, including PostgreSQL microsecond cursor boundaries.
- Sandbox relay retry, batch dedupe, redaction, tool, message, and sub-agent tests.
- Full SDK package gates and real CLI process tests.
- Real local API, CLI, browser, session, OpenCode tool, and database read-back.
- PR merge, Deploy Dev completion, deployed SHA proof, and repeated dev checks.
