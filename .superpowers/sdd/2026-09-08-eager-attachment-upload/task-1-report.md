# Task 1 report — private attachment staging and command references

Status: implemented and locally verified. Ready for independent Task 1 review.

Implementation commit: `a0b410a1bd` (`feat(api): stage private prompt attachments before sessions`).
Canonical branch: `attachments-robustness`.
Worktree: `/Users/jay/root/kortix/suna-attachments-robustness`.
No push, main merge, production DB write, SDK edit, web edit or daemon edit occurred.
`output/playwright/` remains untouched and untracked.

## API contract for Task 3

All four routes use the existing project membership and `PROJECT_SESSION_START` capability gates.
All upload metadata belongs to the authenticated account, project and user.
The private bucket is `staged-files`. Only the server constructs storage paths.

1. `POST /v1/projects/:projectId/attachments`
   - JSON: `{filename: string, mime: string, size: number}`.
   - `201`: `{attachment_id, filename, mime, size, expires_at, chunk_size: 65536}`.
   - Size must be an integer from 1 byte through 50 MiB. Empty/oversized declarations return `413`.
2. `PUT /v1/projects/:projectId/attachments/:attachmentId/chunks/:index`
   - Raw `application/octet-stream`. Each request contains at most 65,536 bytes.
   - Indices begin at zero and increase sequentially. Every non-final chunk is exactly 65,536 bytes.
   - `200`: `{received_bytes, size}`. Use acknowledged bytes for SDK progress.
   - Repeating an acknowledged index with identical bytes returns the same acknowledgement.
   - A changed or out-of-order chunk returns `409`. Oversized actual bodies return `413`.
3. `POST /v1/projects/:projectId/attachments/:attachmentId/complete`
   - Empty body or `{}`. All declared bytes must already exist.
   - `200`: `{attachment_id, filename, mime, size, expires_at}` after verified final-object persistence.
   - Repeating successful completion returns the same handle. Incomplete/busy finalization returns `409`.
   - Storage failure or process-local saturation returns actionable `503`; retry completion on the same handle.
4. `DELETE /v1/projects/:projectId/attachments/:attachmentId`
   - `204` for an unbound upload, including an already removed handle.
   - `409` for a command-bound handle or active finalization.

Prompt file wire: `{type: 'file', attachment_id: string, filename?: string, mime?: string}`.
`attachment_id` must be a UUID. It cannot coexist with `url`.
The API replaces caller filename/MIME with the stored canonical values.
Legacy `data:` and existing native URL parts remain supported.

Transport ruling: parent probes measured the Platinum preview ingress ceiling.
65,536-byte and 98,304-byte requests reached authentication. Requests of 126,976 bytes and above timed out.
The implementation therefore uses durable storage chunks, not one 50 MiB inbound POST.
No runtime must exist during upload. No replica-local temporary file is required.

## Internal interface for Task 2

Module: `apps/api/src/projects/prompt-attachments.ts`.

`resolvePromptAttachment({attachmentId, commandId, projectId, accountId, sessionId?})`
returns `{attachmentId, filename, mime, size, sha256, signedUrl, readBytes}`.
`readBytes(): Promise<Uint8Array>` checks the complete object's byte count and SHA-256.
The resolver requires a persisted command-reference join plus exact account/project identity.
When supplied, `sessionId` must match the command. Task 2 must supply it at the internal HTTP boundary.
Signed URLs expire after five minutes. They are internal delivery values, not public upload responses.
Task 2 still owns the exact command/session/part-index-authenticated daemon pull route and runtime materialization.

`bindPromptAttachments(tx, command, sourceCommandId?)` is the shared transactional binder.
The optional source is trusted server lineage, not a client request field.
A retained `create_session` command must match account/project/actor before bypassing upload expiry for its child prompt.

## Persistence, races and retention

- Generated migration: `20260908152048390_prompt_attachments.sql` plus its Drizzle snapshot/journal.
- Tables: `kortix.prompt_attachments`, `kortix.prompt_attachment_references`.
- Explicit SQL revokes browser-role privileges and enables RLS on both private tables.
- The API writes through its server database connection. No public storage path is returned.
- Metadata exists before storage writes. Every possible chunk path is derivable from that row.
- Ambiguous storage responses leave tracked objects and support same-index/same-handle retry.
- Binding locks attachment rows in deterministic order. Canonical payload and references commit with the command.
- Follow-up enqueue, direct first-session creation, warm claim and queued `create_session` acceptance bind references.
- Queued-create references transfer to the pending-first command even after the original upload expires.
- Limits use canonical byte sizes: 50 MiB/file, 100 MiB/message and 20 file parts, including mixed legacy/handle parts.
- Completion uses at most two concurrent 50 MiB assemblies per API process and 16 concurrent chunk reads per assembly.
- Every storage request has a 20-second timeout. Assembly stops scheduling reads after two minutes, below its five-minute lease.
- All read workers settle before the finalization slot is released.
- Cleanup takes at most 20 unreferenced expired rows. Active finalization leases are excluded.
- Cleanup marks rows deleting before network deletion. Storage removal precedes metadata deletion; failed removal retains the row.
- Upload/complete renew expiry to 24 hours. This protects near-expiry ambiguous writes from immediate cleanup.
- Command references conservatively retain queued, retryable, forwarded, dead-lettered and completed commands until command deletion.
- Queue deletion and owner-scoped expiry renewal share a transaction. Undo can reuse a handle after a queue waited over 24 hours.
- Exact eager warm-claim replays return `200` after the marker is consumed. Foreign, legacy or mismatched claims retain `409`.

## RED / GREEN evidence

1. Handle sanitizer test: RED rejected a valid opaque handle for missing MIME/URL; GREEN accepted it.
2. Partial-body cancellation: RED accepted a truncated chunk after cancellation; GREEN rejects it.
3. Real-Postgres regression suite: RED `4 pass, 2 fail`.
   - Malformed queued handles reached a UUID SQL error instead of an actionable rejection.
   - Removing an expired queued prompt let cleanup destroy the handle before Undo.
   - GREEN: `6 pass, 0 fail`, including storage ambiguity, atomic binding, trusted transfer, cleanup and Undo.
4. Real HTTP warm replay: RED `SESS-28 0/1` because the second identical claim returned `409`.
   GREEN `SESS-28 1/1`; identical replay returns `200`, changed request returns `409`.

## Final verification

All DB verification used isolated loopback PostgreSQL `127.0.0.1:16022` and Supabase `127.0.0.1:16021`.
The parent explicitly configured and started that isolated worktree stack. The primary `54322` DB was not used.
The root runner applied the migration. Parent read-back confirmed both tables exist with `rowsecurity=t`.

Commands use Node 22 at `/Users/jay/.nvm/versions/node/v22.22.3/bin` for `pnpm`.

- `bun test --isolate --env-file=apps/api/scripts/test.env` with:
  `prompt-parts.test.ts`, `pending-prompt.unit.test.ts`, `prompt-attachments.test.ts`,
  `routes/warm-sessions.test.ts`, `session-lifecycle/__tests__/queued-continue-inbox-delivery.test.ts`.
  Result: `62 pass, 0 fail`, 270 assertions. Log: `/tmp/eager-focused-final.log`.
- `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:16022/postgres bun test --isolate --env-file=apps/api/scripts/test.env apps/api/src/__tests__/integration-prompt-attachments.test.ts apps/api/src/__tests__/integration-prompt-inbox.test.ts`.
  Result: `59 pass, 0 fail`, 175 assertions. Log: `/tmp/eager-db-final.log`.
- `pnpm --filter kortix-api typecheck`: exit 0. Log: `/tmp/eager-api-type-final.log`.
- `pnpm --filter @kortix/db lint`: exit 0, `Found 0 issues in 115 files`. Log: `/tmp/eager-db-lint-final.log`.
- `pnpm test -- --id SESS-28`: exit 0, `1/1 passed`, zero skipped.
  Real HTTP uploaded 152,000 bytes in three bounded requests before session creation.
  It exercised actual private storage, completion replay, canonical inbox read-back, warm replay, follow-up dedup and bound deletion.
  Report: `tests/test-results/20260908153634-p0bru4/report.html`.
  Log: `/tmp/eager-sess28-final.log`.
- Route dump used managed flags `KORTIX_BILLING_INTERNAL_ENABLED=true`, `LLM_GATEWAY_ENABLED=true` with fake configuration values.
  Manifest changed from 635 to 639 routes: exactly the four new attachment routes.
- `pnpm --dir tests coverage`: exit 0; `613/639 routes`, 26 allowlisted, `0 uncovered`.
  Log: `/tmp/eager-coverage.log`.
- `git diff --check`: exit 0.

## Remaining verification / risks

- Task 2 runtime materialization, Task 3 SDK/composer behavior and Task 4 browser/preview verification are not implemented by this task.
- Cloud-backed direct first-session HTTP delivery is deferred to Task 4. Queued-create binding and child-reference transfer use real PostgreSQL tests here.
- Full 50 MiB throughput and multi-replica finalization were not measured. Memory/concurrency/deadline bounds are implemented.
- Completed command references deliberately retain files until command deletion. This is conservative storage retention, not active-command-only reclamation.
- Warm replay fingerprints require the same JSON serialization, not merely reordered equivalent JSON. Concurrent warm claims can still return `409` while the winning transaction finishes; a subsequent exact replay succeeds.
- No preview deployment or dev deployment occurred. This checkpoint is not a claim that the complete eager-upload objective is shipped.
