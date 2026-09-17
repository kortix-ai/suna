# Prepare a legacy Suna transfer

The existing Suna migration imports a subset of an account into a new project.
It is not a lossless, cross-instance migration. Do not use its `--apply` mode
for a full transfer from a self-hosted source.

The preparation CLI below reads the source Data API and Storage API. It has no
destination client or apply command. It never starts or modifies a sandbox.

## Development-only scope

Create a private `.legacy-transfer/scope.json` before running the CLI:

```json
{
  "mode": "development-only",
  "source_refs": ["APPROVED_DEVELOPMENT_PROJECT_REF"],
  "allow_source_lifecycle": false,
  "allow_destination_writes": false
}
```

Pass `--scope-file /path/.legacy-transfer/scope.json` when running elsewhere.
The CLI rejects any other source before making a request. There is no force
flag to widen this scope or enable remote mutations.

## Read-only commands

Supply a source service-role key through an environment variable. A Supabase
PAT is a Management API credential, not a Data API credential. Keep source and
destination credentials separate. Never put keys on command lines or in Git.

```sh
bun src/scripts/legacy-transfer/cli.ts inspect \
  --source-ref SOURCE_REF --key-env LEGACY_SOURCE_KEY

bun src/scripts/legacy-transfer/cli.ts storage \
  --source-ref SOURCE_REF --key-env LEGACY_SOURCE_KEY \
  --out /private/path/.legacy-transfer/SOURCE_REF

bun src/scripts/legacy-transfer/cli.ts export-thread \
  --source-ref SOURCE_REF --key-env LEGACY_SOURCE_KEY \
  --thread-id THREAD_UUID --out /private/path/.legacy-transfer/SOURCE_REF

bun src/scripts/legacy-transfer/cli.ts export-table \
  --source-ref SOURCE_REF --key-env LEGACY_SOURCE_KEY \
  --table threads --pk thread_id --out /private/path/.legacy-transfer/SOURCE_REF
```

Run from `apps/api`. Load the approved source environment file explicitly.
The output directory must contain a `.legacy-transfer` component. Git ignores
that directory. It contains private source data and must not be attached to a
PR, preview, or public report.

The ledger preserves full JSON rows, SHA-256 digests, source project refs,
source IDs, and observation times. Export membership is separate from cached
rows, so a rerun can identify its current set without treating stale rows as
current. Table exports compare exact counts before and after pagination.
Matching counts do not establish a database snapshot or prove unchanged rows.
Storage inventory records object metadata, not object contents or content hashes.

The client follows UUID keyset pagination until an empty page. It does not stop
when a server cap returns fewer rows than requested. Storage uses the recursive
`list-v2` endpoint with `with_delimiter: false` and checks cursor progression.
Only its documented read-only POST operation is permitted.

## Identity and visibility contract

- One source thread maps to one destination session.
- Source account ownership resolves through `basejump.accounts` and account
  membership to a source user, then an explicit destination user mapping.
  Required columns: `accounts.id`, `primary_owner_user_id`, `personal_account`;
  and `account_user.account_id`, `user_id`, `account_role`. Missing Data API
  exposure blocks this check. Do not infer the owner from equal UUIDs alone.
- The destination session uses that user's ID as `created_by`, not the source
  account ID, operator ID, or destination account ID.
- Private sessions stay private. Public/shared records need an explicit sharing
  decision; do not silently broaden access.
- Missing destination identities remain unresolved until provisioned or mapped.
  Do not send invitation mail as an incidental side effect of copying data.
- Scope deterministic IDs by source Supabase ref, entity kind, and source ID.
  Development databases can share source IDs with production copies.
- Account/project membership and session ownership are separate. Validate both.
- Restore the source workspace into `/workspace/<legacy-project-uuid>/` inside its corresponding
  destination session sandbox. Preserve relative paths beneath that folder.
  This layout does not require changing workspace mode.
- Keep the imported folder out of automatic Git commits through the sandbox-local
  `.git/info/exclude` when Git is present. Do not change a shared repository just
  to configure one session. Verify exclusion with `git check-ignore` in rehearsal.
- Keep the durable archive under session-scoped authorization. File restoration
  and conversation import must refer to the same destination session owner.
- Private session visibility does not establish Git branch privacy. The Git
  proxy forwards clone/fetch after project authorization. Do not put private
  workspaces or raw conversations in a shared repository and assume private
  session flags protect them.

## Ownership through the Management API

A missing PostgREST schema does not mean its tables are absent. When a source PAT
has database read permission, the dedicated Management API endpoint can inspect
ownership without a direct PostgreSQL connection or changing exposed schemas:

`POST /v1/projects/{approved-dev-ref}/database/query/read-only`

This endpoint runs as `supabase_read_only_user`. Use schema-qualified, bounded
SELECT statements against `basejump.accounts` and `basejump.account_user`.
Keep the same source allowlist and save the returned ownership evidence privately.
Do not substitute the general SQL execution endpoint or change API schema exposure.
The preparation CLI does not implement this optional ownership endpoint yet.

For personal accounts, verify all three records: the account's primary owner,
its owner membership, and the corresponding Auth user. Record original user ID,
source account ID, destination user ID, and the evidence for the mapping.

Creating a missing destination Auth user through the admin API does not send an
invitation. Preserve the source email confirmation state; do not assign a password
or copy session tokens. Add the already-existing user to the destination account
and grant the intended project and agent. Assert the membership endpoint reports
`added`, not `invited`. A personal-account owner does not automatically become an
owner of the combined destination account.

Reference: https://supabase.com/docs/reference/api/v1-read-only-query

## Local native projection

After `export-thread`, create a native import file and row-disposition audit:

```sh
bun src/scripts/legacy-transfer/cli.ts project-thread \
  --source-ref SOURCE_REF --thread-id THREAD_UUID --runtime-version 1.18.23 \
  --scope-file /private/path/.legacy-transfer/scope.json \
  --out /private/path/.legacy-transfer/SOURCE_REF
```

This uses only the local ledger. It requires a completed export and retains the
original thread title. Import the generated `.native.json` only into a disposable
local runtime during preparation. Match the runtime version to the destination
pin before a later execution.

The projection carries text, reasoning, and unambiguous tool results. Events stay
in the raw archive with explicit dispositions. Unknown content blocks remain
visible as raw text and are flagged. Model/billing values remain placeholders;
original usage remains in the raw records. `ready_for_apply` is always false.
Native import success does not prove complete attachment conversion or coverage
of all source formats.

A source-compressed tool row without an assistant or call link becomes a labeled
native history message with its exact source content. Its raw archive retains
the original `tool` role and metadata. A tool row whose assistant ID is absent
from cutoff history uses the same visible fallback; never attach it to a guessed
assistant. A linked result without a source function name uses
`legacy_unknown`, with the missing-name fact recorded in the part metadata.
Malformed tool arguments remain as the exact original string in the native
error part. These conversions preserve source information but change how the
current runtime presents an unlinked tool row.

## Source manifest

Record the complete source set before preparing destination writes:

1. Accounts, memberships, user IDs, projects, threads, messages, resources.
2. Agent versions, run records, triggers, knowledge entries, folders,
   assignments, documents, memories, and connector profiles.
3. Storage buckets and every object path, ID, size, ETag, and update time.
4. Every project-to-sandbox relation. Resolve `sandbox_resource_id` and the
   older `projects.sandbox.id`. Fail on conflicting IDs or account mismatches.
5. Orphan threads, file-only projects, unreferenced resources, pooled sandboxes,
   duplicate external IDs, unavailable sandboxes, and missing owners.
6. Cross-source overlap. A development database can reference production boxes.

Do not interpret an empty `file_uploads` table as an empty Storage bucket.
Do not classify an unreferenced resource as disposable without evidence.
A provider 404 proves unavailability with that credential, not destruction of
all copies. Provider `recoverable` is metadata, not a successful recovery test.

## Lossless preservation and native conversion

Keep immutable raw exports separate from the runtime projection. Preserve every
message type, original ID, timestamp, metadata field, tool result, reasoning
block, attachment reference, usage record, and event. Maintain a mapping from
every original row to its runtime projection or preserved archival record.

The old converter filters on `is_llm_message` and four message types. It drops
reasoning metadata and response events, folds tool results, fabricates model
and usage values, and regenerates IDs. It is not a lossless archive.

Convert against the exact destination runtime version. Do not overwrite a
running runtime's SQLite database with the old hard-coded schema. Validate
imports using the runtime's native readers and actual session endpoints.
Preserve chronological order with a deterministic tie-break for equal timestamps.

Attachment handling must parse structured references and legacy text references.
Download with source credentials, verify bytes and hashes, store under the
correct destination authorization boundary, and rewrite references. Do not
preserve expiring signed URLs as the sole access path.

## Filesystem capture design

No sandbox lifecycle operation is part of read-only preparation. A filesystem
rehearsal needs a source sandbox that is approved for start/restore operations.
Check external-ID overlap before using any environment called development.

For the later authorized capture:

1. Record original state, image, allocated resources, mount layout, and source ID.
2. Quiesce writers or use a consistent provider snapshot. Capture a final delta
   before cutover; Data API reads are not a cross-request transaction.
3. Inventory `/workspace`, home directories, mounted volumes, configuration,
   installed dependency manifests, symlinks, permissions, and relevant services.
4. Keep immutable source archives. Do not remove files because Git ignores them
   or because they exceed 50 MiB. Do not embed credentials in shared Git.
5. Stream bounded chunks to private storage with checksums. Avoid base64 stdout
   and holding each complete archive in API memory.
6. Compare source and captured file counts, sizes, hashes, and metadata. Fail on
   tar errors, truncated data, unsupported entries, or unaccounted exclusions.
7. Restore the original source state. Source cleanup is not a migration step.

A current runtime uses new sandbox IDs. Reproduce user content and required
behavior explicitly; a fresh VM is not a copy of the old machine's identity.

## Session-local workspace layout

```text
Destination session owned by the original user
└── destination sandbox
    └── /workspace/<legacy-project-uuid>/
        ├── original-file.ext
        └── original-subdirectory/
```

Each source sandbox is captured once. Its corresponding destination session gets
its own restored folder. Two users' source trees must not be combined in one
folder or placed in a shared Git branch. Preserve absolute-path references in
raw records and inventory which tools or scripts need a `/workspace` path rewrite.

A box-local folder is not a durable backup. Validate restoration after a cold
rebuild. Once a user resumes work, a retry must never overwrite newer destination
files with the original source archive. Source capture, initial import, and later
destination checkpoints need separate versions.

## Destination execution design

The checked-in preparation CLI has no apply command. The authorized production
run uses private operator scripts and SQLite ledgers under
`.legacy-transfer/production/`. Do not attach those ledgers or raw records to a
PR. The execution stages are:

1. **Preflight:** validate the approved, hashed source manifest and identity map;
   assert destination project, runtime version, capacity, and access policy.
2. **Capture:** preserve raw records, Storage objects, and filesystem archives.
   Record each item as captured only after integrity verification.
3. **Stage:** write private destination archives and runtime-compatible sessions.
   Use deterministic IDs and per-item checkpoints. Keep triggers disabled.
4. **Restore:** allocate fresh destination runtimes and restore one intended
   session/workspace scope. Never install all users' conversations in every box.
5. **Verify:** read exact session/message IDs, content, attachments and files;
   verify owner access and cross-user denial. Test continuation and restart.
6. **Delta:** reconcile source changes after the initial capture. Stop if ownership,
   message rows, or file manifests changed unexpectedly.
7. **Cutover:** make verified sessions discoverable to their owners.
8. **Rollback:** remove or hide only destination objects created by this run,
   using the run ledger. Keep source data and capture archives intact.

Do not mark a run verified when database inserts finish. Do not count an
arbitrary number of runtime session IDs as proof of restoration. Unavailable
source data requires recovery or an explicit exception to the 1:1 requirement.

## Authorized production operator run — 2026-09-15

The user authorized the two standalone production projects and exactly 27
Daytona 404 sandbox exceptions. The cutoff is `2026-09-14T22:13:38Z`. The
Data API cannot create a transaction across the exports. Reconcile writes
after the cutoff before declaring the run complete.

The private `run.sqlite` ledger records source thread, destination session,
owner, title, queue state, source-row count, native-message count, workspace
manifest, and verification proof. `storage.sqlite` records each source Storage
object, archive path, SHA-256, and readback state. A restarted batch reuses a
prepared session. Never generate a second destination session for that thread.

The operator runner checks six durable archive artifacts for a regular
session: raw records, native projection, disposition audit, selection,
workspace manifest, and workspace tarball. It reads the native messages as the
source owner and verifies the exact title, owner, Marko share, restored file
count, and every regular-file hash. It stops the verified sandbox after checking
that its native message count has not changed. `POST /stop` preserves the disk;
`POST /start` must restore the same native conversation and file hashes.

An approved 404 exception has four history artifacts and a fresh provider 404
proof. Its queue state is `verified-approved-404-file-skip`. It does not claim
that files were restored. A missing sandbox reference has no such exception.
Keep it in `workspace-discovery` until an exact project, account, owner, and
sandbox relation is found. Capture a `started` source box in place with two
matching inventories. Return a `stopped` or `archived` box to its original
state. Keep restoring, archiving, and error states in `capture-review`.
If archive bytes verify but Daytona remains `archiving` beyond capture's
180-second state check, keep the session in `capture-review`. The private
delayed-archive checker verifies the capture log, tarball SHA-256, exact source
sandbox ID, and final `archived` state before releasing that session. It
never labels an `archiving` box as preserved.

Image URLs require a matching Storage inventory row and byte-verified private
archive. A pending image keeps its thread in `projection-review`, even when the
native projector reports no unresolved content block. Tool results require an
exact assistant link. The projector supports both legacy tool metadata formats.
An unlinked tool row with no source assistant is a labeled native history
message with its exact content. The raw archive retains its source role and
metadata. Unknown content blocks remain in review.

The runtime proxy can replace an imported inline image URL with
`/kortix/part/`. Verify that reference's session, message, and part IDs.
Fetch its bytes as the session owner and compare MIME, count, and SHA-256 with
the source archive. Two production apply reviews passed after this exact
readback; URL-string equality alone blocked their byte-identical images.

The project allows 100 active sessions. The private runner stops verified
sessions before that cap blocks later imports. Requeue only failures whose
attempt logs show the cap, and reuse their prepared checkpoints. The current
operator batch uses 16 capture and 16 apply workers. Measure provider and API
errors before increasing concurrency again.
The current private batch runner pipelines capture, archive upload, apply,
and stop for each prepared session. It starts the next stage when that
session's proof passes. It does not wait for every selected capture to finish.
The runner retries source preparation three times. The coordinator retries a
failed batch three times against the same ledger. A transport-stalled apply
can leave an existing destination session in `created` or `imported`. Verify
its owner, project, stopped state, archive receipt, and transport logs before
requeueing. Never allocate a second destination session for that source thread.

An admission refusal can dead-letter the create command. Replaying its
idempotency key returns the stored error even after active sessions stop.
Before using a fresh key, verify that the old command has no bound session,
its error is the exact cap refusal, and owner GET returns 404. Keep the prepared
destination session UUID. Record the new key and command evidence in its ledger
proof. One production pilot passed this path without creating a duplicate.

One production pilot resumed a stopped Trimaran session to `ready` with the
same native conversation. The owner API returned all six native messages.
The sandbox download matched the source hash for its one regular file. Marko's
browser showed the title, historical response, UUID folder, and PDF file.
The file view issued an authenticated `/file/content` request that returned
HTTP 200. The pilot returned to `stopped` with six messages unchanged. This
pilot proves that path; it does not verify the remaining queue items.

A compressed-tool production pilot retained all 106 source rows in its private
archive and imported 19 native messages. All six unlinked compressed tool rows
appeared as labeled history messages. Its empty `/workspace` still had a
captured root-directory manifest, a restored UUID folder, and file-count
readback. The session returned to `stopped` after owner verification.

Three source capture pilots verified the lifecycle paths. A `started` Suna box
yielded 216 files and remained `started`. A `stopped` Trimaran box yielded 22
files and returned to `stopped`. An `archived` Suna box yielded 98 files and
returned to `archived`. Every pilot checked the tarball digest and two matching
workspace inventories. These pilots do not establish a provider snapshot.

## Rehearsal and GO gates

A local export rehearsal is read-only and can run now. A full rehearsal creates
new destination resources and can start archived source sandboxes; it is a
separate operation requiring execution authorization.

A complete 1:1 claim remains blocked until all of these have evidence:

- Source ownership map and destination memberships are resolved.
- Private files have a persistence design that does not expose them in shared Git.
- Every source row and file is captured or has an approved exception.
- Latest-runtime native import, attachment rendering, continuation, and restart pass.
- Owner access and unauthorized-user denial pass through the real API and UI.
- The apply implementation supports interruption, retry, duplicates, and rollback.
- Capacity, concurrency, source consistency, and cutover window are recorded.
- The exact cutoff manifest and reconciliation receive readback proof.

## Verification

```sh
bun test apps/api/src/scripts/legacy-transfer
pnpm test
```

Run the focused command from the repository root. Exercise the CLI as a real
process against a bounded source thread and compare source and ledger counts.
Do not call a local export a successful destination migration.

Storage API reference:
https://github.com/supabase/storage/blob/master/src/http/routes/object/listObjectsV2.ts

## Bounded development execution specification

Execution authorization for a development experiment does not authorize a production
transfer. Keep the read-only CLI scope unchanged. Record each approved lifecycle
operation in a separate private experiment ledger.

1. Pin the source Supabase ref, destination API origin, and destination account
   and project IDs. Reject implicit CLI host selection.
2. Select two source threads. Resolve their project/resource/sandbox links again
   through the source Data API. Reject any sandbox in the protected overlap set.
   Record whether the production comparison uses cached or current inventories.
3. Export every thread row and message row into the private ledger. Record source
   account IDs, visibility, original timestamps, and complete raw content.
4. Verify the source account owner and memberships. Matching an account UUID to an
   Auth user UUID is supporting evidence, not a substitute for membership evidence.
   An unavailable schema or failed RPC blocks ownership verification.
5. Resolve destination identities without invitation mail or password changes.
   Do not replace unresolved users with the operator. Keep each mapping explicit.
6. Create the isolated development account/project through authenticated APIs.
   Check existing resources and persist IDs before further work. Provision retries
   must reuse the same idempotency key.
7. Start only the approved source sandbox. Capture its workspace without Git or
   file-size exclusions. Compare inventories before and after capture; verify the
   downloaded archive hash. Stop and re-archive an originally archived sandbox.
   Confirm the final archived state separately from an accepted archive request.
8. After ownership verification, create two private destination sessions with the
   mapped users as owners. Import each conversation into its own native runtime.
   Restore each workspace beneath its original project UUID.
9. Compare all restored paths, regular-file hashes, symlink targets, permissions,
   and supported metadata. Report unsupported metadata explicitly. A workspace with
   no regular files does not prove regular-file restoration.
10. Read conversations and files as their owner. Attempt access as the other owner
    and an unrelated user. Test restart, continuation, and retry without duplicates.

The current filesystem prototype uses a PAX tar archive and retains dotfiles,
symlinks, permission bits, and timestamps. Extended attributes are not captured.
Two matching inventories detect observed changes but do not establish a snapshot.
Home directories and files outside `/workspace` require separate capture. These
limits prevent classifying the prototype as a complete machine transfer.


## Development evidence — 2026-09-14

**Historical gate:** this bounded experiment did not authorize production
execution on 2026-09-14. The user later authorized the production operator run
described above. Completion still requires cutoff reconciliation and readback.

The bounded experiment uses source `cwefmhtthmguktqcysag` and the dev API.
Three source threads map to three private destination sessions under two verified
legacy owners. The first two workspaces contain no regular files. The third
provides the file-restoration test. No source sandbox in the cached production
overlap set is started. All three selected source sandboxes return to `archived`.

| Check | Observed result |
| --- | --- |
| Ownership inventory | 60 personal accounts and 60 owner memberships; all owners resolve to source Auth users |
| Selected raw messages | 17 + 69 + 648 = 734 rows retained in private SQLite ledgers and sandbox archives |
| Native historical messages | 3 + 11 + 99 = 113 messages; IDs, parts and original message timestamps checked |
| Account boundaries | Two real mapped owners; owner session/runtime requests return 200; cross-owner requests return 404/403 |
| Workspace capture | Third archive contains 63 entries, including 55 regular files and 352,442,542 uncompressed file bytes |
| Workspace integrity | Downloaded archive SHA-256 matches; all 55 restored file hashes and recorded modes/mtime match |
| File API | Largest file (48,213,189 bytes) and PNG (135,505 bytes) return 200 and match source hashes |
| Git exclusion | Each restored UUID folder passes `git check-ignore`; raw archives stay outside `/workspace` |
| Restart | Third session: restart 202, start ready, same sandbox/native IDs, all 99 messages and 55 file hashes retained |
| Continuation | Explicit dev model produces `MIGRATION_DEV_OK`; historical messages remain unchanged |
| Completed request replay | Same client request returns 200 and the same prompt ID; successful reply count remains one |
| Browser | Owner sends through the real composer: POST prompts 202, visible `MIGRATION_UI_OK`, then idle |
| File browser | Restored PNG renders at 850 × 1100; file requests use the dev API |
| Titles | Three original source thread names restored through authenticated PATCH requests |

The new dev account initially has no managed-model entitlement. A one-day dev
trial and a $2 internal credit grant enable the continuation checks. The final
trial uses `pro`, which includes managed models. `team` does not include that
entitlement. No Stripe subscription or purchase is created. Trial expiry and
credit usage belong in the private experiment record.

### Remaining failures and fidelity limits

- Five historical image blocks reference production Supabase Storage. No request
  fetches those URLs during this dev-only experiment. Three similarly named PNGs
  exist in the captured workspace, but filename similarity does not prove byte
  identity. Two referenced filenames do not exist in that workspace.
- The third projection reports six unresolved items: those five image blocks and
  one empty assistant row. Native text placeholders and retained raw JSON are not
  equivalent to native image rendering. Do not waive these for a 1:1 transfer.
- The first continuation attempt crosses a runtime restart failure and exhausts
  abandoned-delivery retries. Four user rows appear for that original attempt.
  Later successful-request replay passes; interrupted delivery remains a separate
  failed gate. Do not call the whole retry path idempotent.
- A second-session restart initially fails with `runtime_unreachable_timeout`.
  Manual dev provider start and a subsequent UI restart recover it. The third
  session's normal restart passes without that workaround. This does not erase
  the earlier failure.
- Original thread timestamps are retained in metadata and raw archives. The
  destination session index still displays migration creation time. Import into
  an existing native session does not restore all original native session metadata.
- Original model, token and cost fields require an explicit semantic mapping.
  Historical projection placeholders are not verified accounting equivalence.
- Same-sandbox restart is verified. Lost-sandbox recovery from a durable destination
  checkpoint is not implemented or verified. A box-local archive is not enough.
- Source homes, environment configuration, processes, extended attributes, and
  external Storage dependencies are outside the workspace-only capture proof.
- The bounded restore accepts directories and regular files. Symlink/hardlink,
  interruption, rollback and post-continuation replay require separate coverage.
- The reusable CLI remains preparation-only. Private bounded execution scripts do
  not constitute an approved or interruption-safe production apply implementation.

### Evidence and verification status

Detailed identities, source content, native transcripts, manifests, browser HARs,
checksums and operation IDs remain under ignored `.legacy-transfer/`. HARs and
browser state contain credentials; keep them private and never attach them to a PR.

Relevant private experiment commands, run with the dev environment, include
`verify-real-owner-isolation.ts`, `verify-third-restart.ts`,
`verify-dev-file-api.ts`, and `verify-continuation-proof.ts`. Browser assertions
check both DOM state and captured authenticated HTTP requests. Every command
pins the dev API and destination Supabase host before access.

Repository validation at commit `bcd844344c`:

- `bun test apps/api/src/scripts/legacy-transfer`: 18 passed, 0 failed, 46 assertions.
- `pnpm --dir apps/api exec tsc --noEmit`: exit 0.
- Latest `pnpm test`: 389/391 REST/CLI flows; two sandbox timeout failures and one
  SDK timing assertion fail the overall run. Targeted reruns pass: SBX-3/SBX-5
  2/2; turns tests 57/57. Do not report the latest full run as green.
- Draft PR #7231 passes its API typecheck. Preview verification fails gateway
  routing checks (gateway health identifies `kortix-api`, and expected gateway
  routes return 404). Preview E2E is not green. The CI packages lane also fails one web test.
  No merge or deployment is claimed.

### Checkpoint discipline

Only one process may mutate an experiment ledger at a time. Persist stable
source/destination/native IDs separately from the latest start response: a stopped
response can contain null runtime fields. Record operation IDs before polling.
Never replace the entire ledger from a stale in-memory copy. Production apply
requires transactional checkpoints and a per-run writer lease before it exists.

A dev near-miss exposed this rule: concurrent isolation and restart scripts wrote
the same JSON ledger and lost restart-response fields. No source rows or imported
messages were lost. Server metadata reconstructed runtime state, but missing
operation IDs cannot be claimed as captured evidence. Later operations run
serially and record their own proof files.

### Legacy title mapping and repair

Use a nonblank `threads.name` first. If absent, use the linked
`projects.name`. The project ID must match the thread's project ID. Only use
`Legacy conversation` if neither source field contains a title. Export project
metadata before running the local projection CLI.

A production batch exposed eight fallback titles despite available project
names. The repair uses the session PATCH `name` field, which writes the durable
custom-name override. It preserves the original owner and refuses to replace
an unexpected destination title, since that can be a user rename. Verify the
session index and native runtime title separately; importing historical messages
does not necessarily update an existing runtime session's title.

The regression covers null/blank thread names, explicit thread-name precedence,
and rejection of an unrelated project. Production evidence is retained privately
in `.legacy-transfer/production/title-repair-proof.json` and the E2E reports.

### Workspace completion is independent of transcript completion

A null `sandbox` and null `sandbox_resource_id` mean unresolved workspace
location, not zero files. `resolveSandbox` reports `missing-sandbox-reference`.
Do not mark a history-only import verified. The production completion gate
requires a captured archive hash, matching source/destination entry and regular
file counts, metadata verification, and the expected legacy project directory.
An empty workspace requires the same capture and read-back proof. Explicit
missing-sandbox exceptions remain separate from full verification.

When another approved source contains the same project UUID, verify the same
account, Auth owner, email, and destination owner mapping. Re-read its project
and resource relationship before using that sandbox. Preserve both source
identities and the relationship evidence; do not merge the destination projects.
A creation-time similarity alone never authorizes a sandbox association.

The production restore extracts into an isolated staging directory, verifies
every path, hash, mode, and mtime, then renames the directory into place. An
existing directory is verified, never overwritten. Unsupported entries block
the restore. Compare the full destination inventory, not only expected files.
Verify binary files through the authenticated file API and prove pre-existing
messages remain unchanged. Keep transcript completion and file completion
separate in the ledger and user-facing progress reports.


### Required directory evidence and process audit

Every completed workspace has a real `/workspace/<legacy-project-uuid>/`
directory. Zero regular files is valid only when the captured manifest proves
that state. Preserve empty subdirectories. A missing source reference does not
prove an empty workspace. Never create an empty replacement and call it restored.

The versioned `apps/api/src/scripts/legacy-transfer/restore-workspace.py`
validates a unique manifest root, exact destination paths, complete destination Daytona file download readback, file SHA-256 hashes,
  sizes, modes, modification times, symlink types, and symlink targets. Existing destination changes block a retry;
the restore does not overwrite them. `assertWorkspaceVerified` requires explicit
root-directory, exact-inventory, and file-hash evidence before completion.
Older proofs without these fields require revalidation, not inferred flags.

Run `bun test apps/api/src/scripts/legacy-transfer`. Filesystem tests require
Python 3.12; `LEGACY_TRANSFER_PYTHON` can select another Python >=3.12 binary.
They exercise real archives, empty directories, retries, corrupted archives,
missing roots, duplicate paths, changed files, and destination symlinks.

Full production completion remains blocked until all applicable items pass:

- Every cutoff thread maps to exactly one destination session with its owner,
  title, messages, and required shares verified.
- Every workspace is captured and restored, or has an explicit source-specific
  approved exception. Exceptions remain separate from restored workspaces.
- The 27 approved Daytona `404` sandbox IDs allow histories to import with
  `verified-approved-404-file-skip`. The verifier requires an exact source
  project/box match, fresh provider `404`, four durable history artifacts,
  exact native messages, owner, Marko access, and title checks. It never claims
  a restored workspace for these sessions.
- Source projects without threads are inventoried for files and assigned a
  destination. A thread-only queue cannot prove that all source files transferred.
- Storage attachments and filesystem references outside `/workspace` are
  inventoried and reconciled. Workspace restoration alone does not cover them.
- Source Storage objects move into private `legacy-migrations` paths by source
  reference. A matching object in the other approved source can recover missing
  bytes only after eight identity fields match and both archive hashes verify.
  The ledger keeps `verified-cross-source` distinct from direct source transfer.
- Unsupported filesystem entries remain blocked. The current restore preserves
  symlinks. It rejects hardlinks and does not preserve xattrs or original numeric owners.
- Export membership and final reconciliation account for live changes and
  deletions. A created-at cutoff is not a consistent database snapshot.
- Durable off-box archives and lost-sandbox recovery are verified. Local files
  and a copy inside the destination sandbox do not meet this requirement.
- A session import requires six remotely read-back archive artifacts before
  destination sandbox creation. `assertWorkspaceVerified` rejects a missing receipt.
- Parallel apply has per-session claims, source-sandbox capture locks, retry
  checkpoints, capacity controls, and outer subprocess deadlines. Capture and
  archive stop after 15 minutes. Apply stops after 20 minutes. The current global
  coordinator lease serializes batches.

The OpenCode `/file/content` route can return binary content as UTF-8 text.
Its response changed a 363,046-byte source file into 363,052 bytes in a
production check. Download files through Daytona `fs.downloadFile` for byte
comparison. A separate browser Files check verifies user-facing visibility.

### Production scheduling update — 2026-09-15

The private operator ledger now has `migration_priority` for all 16,685 baseline threads. Preparation and batch selection sort by legacy `updated_at` (fallback `created_at`) descending, with thread ID as a deterministic tie-breaker. Active batches finish their original selection. New batches select up to 500 prepared sessions, with at most 90 concurrent pipelines and existing pressure backoff. Preparation remains bounded to 100 threads per batch and 16 readers. A larger selection reduces the idle tail without increasing active-session limits.

Source lifecycle cleanup now uses fresh Daytona state and waits for an existing archive transition. It does not call stop on an archiving sandbox. Five focused lifecycle tests pass. End-to-end throughput improvement remains to be measured after the running batch finishes.

### Continuous refill and parallel readback — 2026-09-15

The operator runner now overlaps preparation with active transfers. A single source lease owns selection; a temporary claimed-session table prevents reselection. Preparation feeds up to 100 new candidates at a time while workers drain the queue, bounded to 500 selections per run and 90 concurrent pipelines. Backoff limits new dispatch. Preparation failures drain active jobs before surfacing. Source sandbox IDs remain deduplicated within each run.

Destination regular-file readback uses four simultaneous downloads per session. Each file retains its size and SHA-256 assertion. Scratch names are unique; outstanding downloads finish before cleanup on failure. Disk reservation includes concurrent downloads. Five focused refill/readback tests pass. Production rollout loads these changes when the active batch completes; measure sustained throughput before revising the ETA.

Rollout evidence: batch PID 43647 logged `rolling-pipeline-start`, `max_items=500`, `concurrency=67`. Previous pressure backoff is retained; the ceiling is 90. The previous batch was restarted only after source/archive jobs finished and both remaining children proved `imported`, a saved `workspace_restore`, and active file-readback scratch directories. No source capture was interrupted. The coordinator retries with the same ledger session IDs.

### Platinum destination correction — 2026-09-15

New imports explicitly request Platinum. Legacy source capture still uses Daytona. Destination file transfer uses Platinum native `/v1/sandboxes/:id/files` and `/exec`; uploads are SHA-256 checked, use bounded chunks, and are installed with the runtime user as owner. Commands run as `kortix` with `HOME=/home/kortix`; exec timeouts are capped at 300 seconds. Live session readback rejects a provider different from the requested provider.

Bind imported native root sessions to the current runtime `/workspace` project. A template root can retain the `global` project while the repository receives its own project ID. The importer checks the real project, preserves the old root association, updates only the imported root, and verifies that root is present in the workspace session list. Existing native IDs are preserved. Native title readback now applies to file-restoring imports as well as approved file skips.

Both destination project provider transitions report `activated`, target `platinum`. The first pilot (`c68e4d3b-cf14-4f49-8de1-4cc32d05f922`) verifies 89 source rows, 12 native messages, 5 regular files, original ownership, Marko access, and both index/native titles. A fresh second pilot and stop/wake test gate bulk dispatch. Existing materialized Daytona sessions cannot migrate in place: the admin route returns `SESSION_RUNTIME_IDENTITY_IMMUTABLE`. Retain them until a replacement strategy is chosen; project provider activation does not move existing sandboxes.

### Destination archive queue — 2026-09-15

User requested stop followed by archive. The separate archive worker selects only verified imports with stop receipts. It checks current owner/provider and requires both the Kortix session and provider sandbox to be stopped. Reopened sessions are skipped. It requests at most eight archives in flight, records accepted requests as `archiving`, and records success only after the provider reports `archived`. It never deletes a sandbox. New imports continue while cold-storage operations run.

The archive queue is gated by an actual Platinum archive → reopen → native history/title and file hash readback → stop pilot. The dashboard separately reports Platinum verification and destination archive receipts. Existing Daytona imports remain on Daytona per the user’s clarification; only subsequent destinations use Platinum.

Archive pilot result: Platinum reported `archived`; reopening preserved the same Kortix session ID, native ID, and sandbox ID. Native title/history readback and all 5 file hashes passed (12 native messages). The pilot was stopped again. This receipt automatically enables the separate eight-sandbox archive queue. Regular stop/wake and a second fresh Platinum import also passed. Existing Daytona sessions remain on their provider, as explicitly requested.

### CPU and Trimaran completion — 2026-09-15

Platinum download readback now consumes the response reader and writes through a
file handle with backpressure. The previous `Bun.write(path, response)` path left
workers using most of a core for minutes. A live 34-file readback finished in
2.83 seconds using 170 ms CPU. Delayed chunks, empty files, interrupted streams,
partial-file cleanup, size checks, and SHA-256 checks have automated coverage.

Preparation includes `capture-required-cross-source`. It checks the fresh evidence
project, original account, mapped user identity, and exact sandbox ID. It keeps
session history and ownership from the original source. The audit checked all
62 cross-source Trimaran mappings with zero owner or sandbox mismatches.

Source archive cleanup and destination completion have separate receipts.
`release-captured-trimaran.ts` validates the source selection, archive byte count,
archive SHA-256, and manifest inventory before releasing captured files. A source
must report `archived` or `archiving`. The latter creates a pending cleanup record,
not a successful source lifecycle receipt. `confirm-source-cleanup.ts` uses the
independent SQLite `source_cleanup` table and records completion only when the
provider reports the expected state. Destination import still requires all six
durable archive artifacts, exact restored inventory, and every file hash readback.

Uncaptured sources in provider error remain blocked. Recovery calls apply only to
sources whose API explicitly reports `recoverable: true`. Any additional missing
file exception requires an explicit user decision and an exact source scope.

Import retries apply archive permissions only to expected final artifacts.
Interrupted-upload staging files may belong to root and must not enter the
runtime user's permission command through a wildcard. Native import failures
save a private diagnostic containing the exit code and command output.

### Explicit unrecoverable-volume exception — 2026-09-15

The user authorized a history-only import for Trimaran source project
`de55c5ec-752e-46a2-8da3-31b699dc8c7d`, sandbox
`1af0b1dc-e5e7-450c-b761-bef63778e4ed`. Fresh source API checks confirmed the
project/owner mapping, provider `error` state, `recoverable: false`, and the
missing-volume error. This exception does not broaden either earlier skip policy.
The verifier requires an exact source/project/sandbox match, explicit authorization,
four durable history artifacts, and verified history, owner, and Marko access.
It rejects capture or restore evidence for this exception.

Destination session `7c49e6b8-3753-4ff5-a9d0-4518dbf423b8` imported 1,529 source
rows as 239 native messages on Platinum. It retains the original owner and title.
Its status is `verified-approved-unrecoverable-file-skip`, with
`files_status: unavailable`. A hash-verified `FILES_UNAVAILABLE.txt` notice lives
in `/workspace/de55c5ec-752e-46a2-8da3-31b699dc8c7d/`. The notice is a migration
artifact, not a restored source file. Stop readback passed after the import.

### Throughput recovery — 2026-09-15

A 150-session Suna sample measured median capture 5.6 s, source lifecycle cleanup
35.3 s, durable archive upload 5.6 s, and destination import/verification 32.1 s.
Capture and cleanup use proof timestamps. Upload and import use successful
first-attempt log completion times. These are separate stage medians, not an
end-to-end latency percentile. Local migration CPU was 5.2% at inspection.

The operator reset Suna's next batch admission to 24 pipelines. The pool retains
up to 64 worker slots, admits only the effective concurrency, and reduces that
count by 25% on pressure with a floor of eight. After five minutes without new
pressure and at least 20 successful imports, it adds four admissions, at most
once every two minutes. Prior cumulative errors no longer prevent recovery.
Selections now span up to 1,000 sessions to reduce batch-drain overhead. Source
cleanup still occupies a pipeline; overlapping it with destination work needs
separate lifecycle tracking and concurrent checkpoint-write protection.

Rollout evidence: PID 59974 logged `rolling-pipeline-start` at 18:48 UTC with
`max_items: 1000` and `concurrency: 24`. The previous batch completed normally.
Five controller/refill tests passed. Sustained throughput at the new admission
count remains to be measured.

### Measured Platinum control-plane limit and follow-up probe — 2026-09-15

The initial tally from the first 32-pipeline probe counted 33 rate-limited import attempts:
28 on Platinum `/exec`, five on `/files`. Responses supply `Retry-After: 1`.
The adapter now retries only rejected 429 requests, with the server delay plus
jitter. It does not retry ambiguous failed execution responses. Small uploads
use two calls instead of four: upload staging bytes, then hash-check, change
ownership, move, clean the staging chunk, and hash-check the destination in one
command. A digest mismatch exits before replacing the destination. Multipart
uploads retain bounded chunks and a complete-file digest check.

Live capacity commands use `scale-control-suna.json` with a unique ID, a target,
an expiry, and an optional hold of at most ten minutes. Targets remain within
8..90. Holds stop automatic increases but never pressure backoff. A separate
probe measures 32, 48, 64, 80, and 90 pipelines after warm-up. It records completed
imports and hard pressure in `capacity-probe-results.json`, stops on hard
pressure or a throughput decline under throttling, and retains the best measured
level. These are short-window observations, not a permanent capacity guarantee.

For dispatcher handoff, source captures drain first. A slow destination readback
can retain its process and session lease under `apply-draining`; a dedicated
watcher verifies its completion checkpoint, reconciles the queue, and stops only
a verified session. It returns incomplete work to review. This avoids blocking
all other imports on a single long readback. New completion timestamps are written
after file verification, so throughput counts do not use a pre-readback timestamp.

The optimized 32-pipeline sample completed 44 imports in 120 seconds (1,320/h).
The repeated 48-pipeline sample completed 46 in 120 seconds (1,380/h), with no
hard pressure or recovered throttles in that sample. A previous 48-pipeline
attempt encountered one source Daytona 502. Another attempt failed a file
readback with 404 after a recovered 429; that is a file verification failure,
not evidence that retries exhausted the provider rate limit. The failed session
remains unverified. Retry log messages now use a separate throttle-retry marker;
the capacity probe inspects the final error when classifying older logs.

Validation: `bun test ./.legacy-transfer/production/platinum-destination.test.ts
./.legacy-transfer/production/concurrency-controller.test.ts
./.legacy-transfer/production/refilling-pool.test.ts` reports 20 passed, zero
failed, and 112 assertions. The dispatcher builds successfully with Bun.

The 64-pipeline probe hit the application's `project_session_create_limit`:
100 creates/hour per API replica, enforced by the in-process token bucket in
`apps/api/src/shared/rate-limit.ts`. Its config property is absent from the config
schema, so account seats/credits and a runtime environment variable cannot raise
it in this version. The probe stopped; 80 and 90 were not tested. Short successful
samples therefore do not prove sustained throughput above the create quota.

Quota-aware retries apply only to migration POSTs with a fixed session UUID.
They honor bounded server delays, check that UUID for an existing destination,
and use a fresh lifecycle command key after a terminal quota rejection. This
avoids replaying the API's cached quota error as HTTP 500. Ambiguous errors do not
trigger a new command key. Two policy tests pass with ten assertions. The operator
requeued 25 terminal quota failures only after confirming their durable archives,
mapped owner, absence of a create checkpoint, and live destination 404.
The public API quota remains enforced. The migration now uses the existing
internal lifecycle override described below.

### Authorized migration-only quota bypass — 2026-09-15

The production lifecycle worker already supports `enforceAccountCap: false` on
internal create commands. The operator now enqueues those commands with source
`admin`, the original mapped owner as `actor_user_id`, a fixed destination UUID,
private visibility, Platinum, and an idempotency key unique to the source thread.
The command remains in the production lifecycle ledger; production code creates
the destination. No production server change or global limiter change is needed.
Billing checks remain active. This internal flag also bypasses active-session
caps, so the private migration runner retains its 90-pipeline ceiling and normal
provider-pressure backoff, followed by verified stop/archive processing.

The private policy permits only Suna and Trimaran's two destination project UUIDs
inside the Libremax account, validates source metadata and durable archive proof,
checks live owner access and destination existence, and expires September 22 UTC.
`migration-create-overrides.ndjson` records each command, destination, and owner.
Existing destination owner/provider mismatches stop the import. A queued command
is reused by idempotency key; failed or unknown commands are not marked verified.

Canary `00b64340-d36a-40fc-a751-e03526c21e4b` used command
`031012a9-8a43-40e4-a083-3864b0ff9243`. It passed full history/owner/sharing checks,
79 independent file downloads and hashes, and reached `verified` at
2026-09-15T19:25:36.503Z. The stop helper returned `already-stopped`. After this
proof, the operator enabled the override for both migration sources and resumed
64/80/90 capacity probes. Twenty-three focused tests pass with 132 assertions.

Post-bypass capacity samples: 64 pipelines completed 52 imports in 120.1 s;
80 completed 65 in 120.1 s. During the 90-pipeline probe, 50 completed in 90.1 s,
then pressure backoff reduced admissions. One long readback disconnected; its
retry verified at 19:34:05 UTC. One source Daytona capture returned 5xx. Both
operations started at earlier concurrency levels, so these events do not prove
a fixed 90-pipeline capacity ceiling. The probe restored 80, the best measured
window without pressure failures. Automatic backoff/recovery remains enabled.

### Continue scaling and release completed source captures — 2026-09-15

One Daytona 5xx occurred across 438 capture attempts after the quota bypass.
That observation does not establish a provider capacity ceiling. The runner keeps
its measured operating target and automatic recovery; investigate sustained error
rate and completed throughput before attributing a limit to concurrency.

The Suna capture reconciliation released 38 completed workspaces after rechecking
archive size/SHA-256, manifest inventory, source selection, and live archive state.
Twenty-one still had source archive cleanup pending. The two-minute reconciliation
now runs this check before delayed archive confirmation. Active session writers
are excluded. Source archive completion remains in the independent cleanup ledger;
destination import, ownership, history and file-readback verification are unchanged.

The current process recovered to 90 pipelines at 19:41 UTC. The next batch is
configured with a 128-pipeline ceiling and exploration enabled: +16 after two
quiet minutes and 20 successful imports. Pressure retains 25% backoff and returns
to conservative +4 recovery after five quiet minutes. The running process keeps
its original 90-slot pool until it drains; 128 has not yet been exercised live.
Controller/refill tests report 12 passed, zero failed, 87 assertions. The dispatcher
build passes. The pacing assertion allows one millisecond between the admission
and job timestamp, while still asserting the complete spacing window.

### 112-pipeline probe and shared Platinum write budget — 2026-09-15

The 1,000-item batch drained to three long file readbacks. Those appliers retained
their session locks under dedicated completion watchers. The dispatcher handed
off to a 5,000-item batch; initial concurrency validation now accepts up to 128
only with the authorized migration override. The new coordinator is PID 31245.

The unpaced 112-pipeline probe exhausted Platinum `/exec` and `/files` retries.
Provider provisioning errors explicitly report an organization limit of 20 write
requests/second. Twenty-five Platinum runtimes had no external sandbox after
that refusal. This is separate from the application's hourly session-create quota.

Private workers now share a SQLite write budget: file/exec mutations are paced
at ten/second, and internal create commands at one/second. Request retries consume
the same budget. Backend setup calls and other organization traffic are outside
this local budget, so these settings reserve headroom rather than claiming a
global guarantee. The independent-connection pacing test and adapter/controller/
refill tests report 23 passed, zero failed, 119 assertions.

The paced 112-pipeline probe observed zero Platinum 429s from 19:55:34 UTC through
inspection. Two Daytona capture attempts returned 5xx; the controller reduced
concurrency to 84. 128 has not been tested live. Automatic quiet-window recovery
remains enabled. This observation does not establish a permanent provider ceiling.

Two bounded recovery workers handle the 25 unmaterialized creates and 21 terminal
file/exec throttles. They verify the original owner/provider and archive checkpoint,
retain session IDs, and use the existing lease/verification/stop flow. Restart is
used only for rate-rejected Platinum creation with no recorded runtime or native
history. Existing sandbox write retries do not invoke restart. Six create failures
and four write failures had passed complete verification at inspection; the rest
remain pending recovery, not complete.

### Correct isolated transient-error backoff — 2026-09-15

The paced source capture window contained two failed attempts among 123 (1.6%).
The old controller reduced global concurrency on any exhausted 5xx, transport
error, or timeout. That sample did not establish overload at 112 pipelines.

The private dispatcher now evaluates transient failures within a rolling two-minute
window, separately by source and phase. Backoff requires three distinct failing
resources and either three consecutive distinct failing resources or a failure
ratio of at least 5% across at least 20 attempts. Repeated failures of one resource
do not trigger global backoff. Exhausted explicit rate-limit and capacity refusals
retain immediate backoff. Per-session retries and verification remain unchanged.

A temporary live guard applies this policy to the current dispatcher without
interrupting source captures. It restores only reductions attributed to isolated
transient failures. It exits when the next dispatcher advertises native policy
version 2. The guard restored 112 at 20:05:08 UTC; automatic recovery reached
128 at 20:07:08 UTC. This is an exercised concurrency level, not a proven sustained
throughput result. Shared Platinum write pacing remains active. Old standalone
capacity probe scripts classify individual 5xx as pressure; do not reuse those
scripts without aligning their classification with this policy.

Validation: `bun test ./.legacy-transfer/production/transient-pressure.test.ts
./.legacy-transfer/production/concurrency-controller.test.ts` reports 13 passed,
zero failed, 254 assertions. The dispatcher build passes. The tests include the
two-of-123 case, sustained failures, expiry, phase isolation, and repeated errors
from one sandbox. The 20:07:25 UTC live observation recorded 210 phase attempts
and zero rate-limit, transport, capacity, or timeout failures over two minutes.

### Prepare higher concurrency and reclaim verified cache — 2026-09-15

The dispatcher implementation now accepts a ceiling of 192. Production settings
remain at 128. The running dispatcher has a fixed 128-slot pool; a file edit does
not enlarge that pool. Higher levels require a subsequent dispatcher and a fresh
capacity observation. The planned comparison is 128, then 160, then 192, retaining
the shared Platinum write budget and comparing completed imports rather than
worker count. No 160/192 production result exists yet.

At inspection, failed capture logs identified 21 distinct source sandboxes reporting
`restoring`. These lifecycle failures are separate from the original two isolated
5xx responses. Stable-state reconciliation remains active. Higher admissions are
not enabled while this source transition backlog is unresolved.

Free disk approached 22 GiB against the 20 GiB reserve. The private
`prune-verified-workspace-cache.ts --apply` reclaimed 14,030,065,135 bytes from
2,872 workspace tar caches, restoring 35 GiB free. It acquires the session, capture,
and archive leases; requires verified destination inventory/hash/readback evidence
and preserved source state; checks archive identity and every remote part receipt;
and rehashes each local tar before removal. It retains manifests, histories, receipt
files, remote archive objects, and destination files. The operation logs each
validated archive and completed removal in `cache-prune.ndjson`.

A later operation that needs a pruned tar must reconstruct it from the ordered
remote receipt parts, verify each part size/hash, and verify the complete archive
size/hash before reuse. Do not rerun capture or mark a cache miss as unavailable
source files. The pruning command does not perform a fresh remote download; it
uses the upload worker's independent readback receipts plus verified destination
file evidence.

Validation: controller, transient-pressure, and refilling-pool tests report
18 passed, zero failed, 273 assertions. The dispatcher build passes. The higher
concurrency test failed before raising the implementation ceiling, then passed.

### Platinum capacity incident — 2026-09-15 20:47 UTC

Verified throughput reached zero in the observed two-minute window. A destination-
scoped provisioning query found 68 sandbox records with `503 no capacity` in
`eu-west`, 39 with `503 overloaded`, 37 with unknown image state, seven creation
timeouts, five provider statement-timeout errors, and one per-IP spawn 429. These
are persisted record counts, not an interval request rate. Generic runtime-start
errors hid these categories from phase-level telemetry.

Operator control requests eight pipeline admissions and a ten-minute growth hold.
Existing operations drain; no destination deletion or provider switch occurs.
Recovery and higher scaling require successful provider provisioning and verified
imports. The direct adapter's last recorded 429 predates this incident, which does
not establish provisioning health.

### User-authorized bidirectional destination routing — 2026-09-15

The user authorized fallback between Daytona and Platinum after the Platinum
capacity incident. New imports now select `destination-routing.json.preferred`,
currently Daytona. The first request persists its provider in the local proof.
Retries retain that provider and the same session ID. Existing destinations keep
their provider; this change does not move an initialized runtime or its files.

The scoped internal create policy explicitly allows both providers. It retains
source/project/account/owner/archive gates and validates the provider in both the
durable command and session readback. Its historical idempotency prefix remains
unchanged to avoid creating a second command identity.

`run-provider-routing.ts` checks destination-scoped provisioning errors every
minute. Three recent distinct sandbox records with capacity/availability failures
trigger fallback for future creates when the alternate has fewer than three.
If both providers meet that failure threshold, admission drops to eight. The
monitor counts records updated within five minutes; absence of errors is not
proof that an unused provider is healthy. Real imports test the selected provider.

The same monitor raises admissions by 32, up to the running pool ceiling of 128,
after three minutes between increases, at least 20 verified selected-provider
imports in the last three minutes, and zero matching recent provisioning errors.
Controller pressure backoff and shared write/create pacing remain active. The
manual restart advanced eight to 32, then 64 after the first verified import.

Daytona pilot `e155fb9c-2f58-4d92-a2ca-462d2cb1ef69` verified history and an empty
workspace inventory, then stopped. Additional pilot
`71499632-624d-4bcd-818c-db0bcc90b035` verified four files, original owner, Marko
sharing, and native history. At inspection, nine new Daytona imports were
verified. Routing/create-policy tests report three passed, zero failed, 16
assertions; the importer build passes. Bidirectional selection is unit-tested;
no artificial production Daytona outage was induced. Failed pre-existing
Platinum creates remain in the recovery ledger and have not been switched.

### Platinum primary, Daytona fallback, recurring recovery probes — 2026-09-15

The user clarified that Daytona is fallback only. `destination-routing.json` now
records Platinum as primary and Daytona as fallback. New imports remain on
Daytona while Platinum recovery is unconfirmed. The routing monitor returns new
imports to Platinum only after a fresh successful full-import recovery probe,
with no recent matching Platinum provisioning errors. A success from before the
last routing change cannot trigger a return. Initial return admissions are 16;
normal verified-import scaling then resumes.

`run-platinum-recovery-probes.ts` runs one probe at a time, waiting five minutes
after each finishes. Each probe selects a failed Platinum migration creation with
no remote/native runtime IDs in either the provider record or local proof, checks
owner/provider/archive evidence, claims its queue row, and restarts through the
existing API. Full import verification and stop precede the success receipt.
Existing initialized destinations are excluded. Two singleton leases prevent
duplicate probe supervisors and overlapping probes.

The first probe is session `5f418f13-eef0-416f-ba5b-ac221999a352`; it reached
`ready` with external/native IDs during inspection. Full verification was still
running; readiness alone does not authorize returning bulk traffic to Platinum.
Admissions recovered to 120 and the operator requested 128.

Routing tests: two passed, zero failed, nine assertions. Cases include both
fallback directions, two unavailable providers, fresh primary recovery, no probe,
recent Platinum failure, obsolete recovery receipts, and receipt expiry. The
probe build passes. Cache reclamation removed another 5,847,355,994 bytes from
1,309 verified workspace tar caches; free disk measured 30 GiB afterward.

The first Platinum probe subsequently completed full verification of 319 files
and stopped at 21:21:51 UTC. The operator's 128 admission request was acknowledged
at 21:21:23 UTC. The next routing sample can now restore Platinum as primary at
the bounded return target, then increase on verified throughput.

### Disk-reserve stall and continuous cache maintenance — 2026-09-15 21:43 UTC

The 30-minute dashboard rate fell to 184/hour. At inspection, disk had 17 GiB
free, below the 20 GiB capture/readback reserve. Of the inspected 200 failed
attempts, 174 reported `Local disk reserve`; the remaining 26 reported source
restoring-state errors. Nearly all active pipelines were capturing and no imports
completed in the recent two-minute windows. The controller stayed at 32 because
its growth gate requires completed imports.

Verified-only cache reclamation now accepts workspace tar, raw-record JSON, or
native JSON. Each file must match its remote receipt parts and full local hash,
and the session must pass full workspace verification with preserved source state.
The existing session/capture/archive leases exclude active writers. The pass
removed 156,393,550 tar bytes, 4,068,746,150 raw-record bytes, and 2,227,820,924
native JSON bytes. Free disk returned to 23 GiB.

`run-cache-maintenance.ts` checks free space every minute and runs the same
verified-only pruning below 25 GiB. It logs observed free space before and after.
It retains source SQLite exports, unverified session artifacts, manifests,
selection/audit records, and durable archive receipts. Pruned JSON can be restored
from its ordered remote receipt parts with per-part and full-file hash checks.

After reclamation, 17 sessions recorded completed captures within two minutes.
No imports had yet completed in that window; source lifecycle cleanup and later
phases still had to finish. The dashboard's 64-hour estimate extrapolates the
degraded trailing average; it is not a measured duration for the remaining work.

### Mac build-cache cleanup — 2026-09-15

The user authorized a broad cleanup. Inactive Next.js `.next` directories
accounted for the largest reclaimable space. The cleanup removed 15 generated
`apps/web/.next` directories, totaling 100.21 GiB by allocated-size inspection.
It excluded any worktree with a live process working directory, refreshed that
check before each removal, rejected symlink targets, and required `git ls-files`
to report no tracked content beneath the target. Active worktrees, source code,
dependencies, migration records, and unverified artifacts remained intact.

The deletion manifest is `/tmp/kortix-build-cache-cleanup-1789508987.json`.
`df -h /Users/markokraemer` reported 122 GiB available afterward. Migration
admissions reached 80; the 21:49:37 UTC observation recorded 46 verified imports
in two minutes, with zero reported quota, transport, capacity, or timeout errors
in that window. This short sample is not a sustained throughput guarantee.

### Transfer restart and destination data-plane routing — 2026-09-16 02:19 UTC

The coordinator stopped at 01:16 UTC after its three-attempt retry budget, with
dotenv decryption failures recorded. Environment validation now succeeds without
printing secret values. The fresh Platinum write probe returned HTTP 503 with
`control plane is at its in-memory body budget, retry shortly`; this is a provider
control-plane failure, not local disk exhaustion.

The provider monitor now includes recent destination phase telemetry. It deduplicates
by session/provider, discounts successful retries, ignores source captures and old
records, and requires at least three failing sessions and a 5% failure ratio.
Routing tests plus destination-pressure tests report six passed and 14 assertions.
The monitor build passes. New work uses Daytona fallback until a fresh full
Platinum recovery succeeds. Initialized destinations retain their current provider.

`run-transfer-services.ts` started at 02:19:35 UTC and owns coordinator, review,
stop, archive, provider-monitor, Platinum-probe, cache, and bounded destination
transfer-recovery workers. It holds a singleton lease and sleep protection and
restarts exited workers after a delay. The supervisor starts from an environment
validated for production credentials. Recovery uses existing session IDs and
checkpoints, with no runtime deletion. Upload/socket failures enter bounded retry
batches with a fifteen-minute per-session cooldown.

The dashboard API at 02:19:37 UTC returned `running-with-reviews`, one coordinator,
one batch dispatcher, and 7,424 verified sessions. The dispatcher logged a fresh
5,000-item batch at 32 admissions. New completions were not yet measured at that
initial restart check.

### Archive upload bottleneck and independent capacity limits — 2026-09-16

The observed 398/hour trailing rate hid a current 204/hour five-minute rate.
The 30-minute phase telemetry contained 105 archive timeouts. Sixty archive
workers remained active after global admissions fell to eight. Sample logs
verified selection, audit, raw records, native history, and manifest, then
stalled before the 13–19 MB workspace archive received a verified part.

New archives use 4 MiB chunks beneath a distinct `chunks-4m` object namespace.
Existing part receipts keep their original 32 MiB layout; mixed layouts fail.
Uploads send the exact buffer used for the expected hash. Upload response bodies
are closed, request failures are logged, and upload requests have a 90-second
limit. The pilot session `50179b6d-5dce-488b-ad0b-a415baf52531` completed all six
archive receipts, including three verified workspace parts totaling 11,498,162
bytes. It returned to the prepared queue afterward.

A separate archive network lease pool limits transfers independently of session
pipeline admissions. It started at eight slots, then increased to 16 and 24
after successful archive readbacks. The 62 old uploader processes were stopped
for checkpoint-safe retry with the new code; source captures and destination
imports were not stopped. `run-archive-requeue.ts` returns inactive archive-review
rows to preparation only with captured/preserved-source evidence and all six
local artifacts, with a 15-minute requeue cooldown.

A transport probe exposed a local Bun behavior: writing a 1 MiB BunFile slice
with `Bun.write` copied the entire 11,498,162-byte source. The corrected probe
materializes the slice buffer explicitly; its 1 MiB curl upload returned HTTP
200 in 8.599 seconds. Migration chunk hashing/readback still rejects byte
mismatches. The probe result is not a full-link bandwidth benchmark.

After the change, a two-minute window had 43 successful captures, 15 successful
archives, and four successful imports, with no failed phase completions in that
window. Admissions increased from eight to 64 and then 96; archive slots are 24.
The requested 1,000 verified imports/hour was not yet established at that check.
Archive-layout tests report two passed, zero failed, four assertions; uploader
build succeeds.

Capacity follow-up: pipeline admissions reached 128 and archive network slots
reached 32. A later two-minute sample completed 35 verified imports (1,050/hour);
the five-minute sample completed 71 (852/hour). The trailing 30-minute window
still included the archive stall. These are observed window rates, not a
sustained 30-minute guarantee. A ten-second interface sample measured 23.01 Mbps
upload and 62.26 Mbps download; it does not establish the connection's ceiling.
Fifteen archive-layout, destination-pressure, and controller tests passed with
89 assertions.

Archive slots later increased from 32 to 48. Sixty-five uploader processes that
had already loaded the old 32-slot validator rejected the new setting. This was
an operator rollout error. Retry processes loaded the new 64-slot validator. In
the next 75-second phase window, 22 archives completed and three timed out; no
provider or storage error appeared in that window. Pipeline admissions remain
128 for the current dispatcher. The next dispatcher retains the 128 ceiling.

The clean 45-second window at 48 archive slots completed 14 imports, equivalent
to 1,120/hour. The following 90-second aggregate fell to 840/hour while five
archive processes exhausted the 15-minute attempt timeout. Reducing the configured
limit did not stop the 48 transfers already in flight. The stable limit returned
to 32. The next dispatcher uses a 45-minute archive attempt timeout and retains
a 128-pipeline ceiling. This prevents a large multi-part archive or network-slot
wait from causing a premature global backoff. The 1,120/hour observation is a
burst result; the sustained 30-minute rate before this probe was 720/hour.

At 14:59 UTC, pipeline admission was 16, and the provider monitor counted 14
verified Platinum sessions in three minutes with zero recent provider failures.
Its previous 20-session threshold blocked an increase at that rate. A live
control raised admission to 32. The supervised provider monitor now probes
another 16 admissions after six verified sessions in three minutes, zero
preferred-provider failures, and three minutes since the prior probe. Its
ceiling remains 128. The pipeline controller still backs off on sustained
pressure. Archive network slots remain at 32 after the 48-slot timeout probe.
The monitor restarted under `run-transfer-services.ts` at 15:00:22 UTC.
The pipeline controller reached 64 admissions at 15:04:14 UTC. At 15:05:25
UTC, three distinct Platinum `/files` attempts had returned HTTP 502 or 503.
The monitor routed new sessions to Daytona and reduced admission to 16. It
continues probing for Platinum recovery. Existing session providers do not
change. An archive network-slot lease read also hit a partial JSON write;
new uploader processes retry that transient lease race.

At 16:22 UTC, the controller had probed 88 admissions on Daytona. HTTP 429
responses in capture and apply attempts triggered three successive 25% backoffs:
88 to 66 to 49 to 36. The controller continues probing after quiet windows;
this is a multiplicative backoff, not a small fixed decrement. Platinum had
remained unused for new sessions after the 15:21:30 fallback because its last
explicit probe completed eight seconds before that timestamp. Two fully
verified Platinum imports at 16:09 and 16:10 UTC establish post-fallback
recovery. The routing monitor now accepts two such file-verified imports within
20 minutes, with zero recent Platinum failures, as recovery evidence.

At 18:41 UTC, the trailing 30-minute ledger count was 225 verified Suna
sessions (450/hour). The dashboard displayed approximately 490/hour on its
rolling window. Admission was 16 after repeated provider switches, while only
12 of 32 archive slots were active. Free disk was 26 GiB. The verified-cache
pruner validated remote archive receipts and local hashes, then reclaimed
7,877,599,384 bytes from 2,504 completed workspace archives. The resulting
free disk was about 34 GiB. A 32-admission probe had no destination failures
but verified 14 sessions in two minutes. At 48 admissions, three distinct
Platinum `/files` attempts failed with HTTP 5xx, causing Daytona fallback.

The monitor now resets to 32 rather than 16 on a provider switch and requires
a three-minute Daytona dwell before returning to Platinum. The next batch
runner will exclude late imports pinned to the former provider from the new
provider's admission pressure. The currently running batch loaded the old
runner code; do not count this change as live until that batch exits.

Follow-up capacity check at 18:48–19:04 UTC: Platinum completed 59 apply
attempts in the first three minutes at 44 admissions, but 15 of 30 later
attempts failed during a connection burst. PostgreSQL reported
`CONNECT_TIMEOUT` / `CONNECTION_CLOSED`; Platinum `/exec` also refused
connections. The admission controller reduced concurrency to 24. TCP checks
to both endpoints passed after the burst. The local process file limit was
1,048,575, with 396 established TCP connections at the check, so file
descriptor exhaustion was not established. The private migration-create path
now reserves its existing one-per-second create budget before opening a
PostgreSQL connection. New subprocesses load this change immediately.

The Platinum monitor is capped at 40 admissions and refreshes a ten-minute
hold before the current batch can automatically exceed the cap. At 19:00 UTC,
the last five minutes contained 85 verified Suna sessions (1,020/hour). The
19:03 check contained 89 (1,068/hour), while the provider monitor reported
zero outstanding destination failures; the 30-minute rate was still 706/hour.
These are five-minute rates,
not a sustained 30-minute result. When fewer than 100 fresh Suna sessions
remain, the next destination-recovery run increases from two workers/eight
selected reviews to eight workers/32 selected reviews, ordered latest first.
The current recovery run loaded the previous limits.

At 19:05–19:12 UTC, Platinum `/files` returned another distinct-session 5xx
burst at 40 admissions. The monitor routed new sessions to Daytona, and the
pipeline reduced admission before probing upward again. The Platinum adapter
already spaced write starts by 100 ms; it did not limit simultaneous uploads.
New apply subprocesses now use `platinum-file-slot.ts` to cap in-flight
`/files` PUT requests at 12. The adapter still stages each upload, verifies
its hash before finalizing, and checks restored files by download. The
router returned to Platinum at 19:13 UTC and raised admission to 40 at
19:16 UTC. Eight Platinum sessions had verified after the adapter change by
19:15 UTC. The current batch loaded the older admission-pressure code; its
replacement starts after the batch finishes.

At 19:19 UTC, PostgreSQL `CONNECTION_CLOSED` recurred while source captures
also failed. The pipeline backed off from 40 to 30, then the router restored
40 at 19:21 UTC. The local `route get` command put both the production
PostgreSQL endpoint and `api.platinum.dev` on `ipsec0` (MTU 1280). Subsequent
TCP and HTTP probes to both endpoints succeeded. This establishes a shared
egress path, not a proven VPN fault. The in-flight Platinum upload limit did
not eliminate the cross-service connection burst. Do not claim that a
five-minute 1,000/hour sample is sustained throughput.

At 23:29 UTC on 2026-09-16, the Suna queue held 15,321 verified sessions,
534 destination reviews, 186 source-capture reviews, 14 prepared sessions,
14 queued sessions, and three active destination recoveries. Trimaran held
612 verified sessions and one source-capture review. These are ledger states,
not a claim that the transfer is complete.

The workstation now loads `ai.kortix.legacy-transfer` and
`ai.kortix.legacy-transfer-dashboard` as user LaunchAgents from
`~/Library/LaunchAgents/`. The first starts the existing migration supervisor
through dotenvx; the second serves the read-only status page on
`http://127.0.0.1:8790/`. `launchctl print gui/$(id -u)/ai.kortix.legacy-transfer`
must report `state = running`, and `curl http://127.0.0.1:8790/api/status`
must report the current ledger counts. Both agents use `KeepAlive`; remove
them with `launchctl bootout` after the migration closes.

The supervisor's destination-recovery interval is now 30 seconds after each
pass. With fewer than 100 fresh Suna sessions, the recovery pass selects up
to 48 latest retryable reviews and runs 12 workers. The Platinum `/files`
upload limit remains 12 in flight. Recovery never changes the provider of an
existing session. The runtime-start retry path calls `/restart` only when
both external and native runtime IDs are absent; every completed session
still passes owner, sharing, title, native-history, and workspace proof checks.

After a supervisor interruption, compare `migration_queue.state` with
`sessions.status` before admitting more work. Four dead `apply-draining`
claims were returned to `apply-review` after their worker PIDs were confirmed
absent. Another 39 fully verified, stopped sessions still had `prepared` or
`apply-review` queue states; the owner API, operator share, title, provider,
and workspace/exception proofs passed for all 39 before their queue states
were set to `verified`. Nine captured source workspaces remained in
`capture-review`; each local archive hash, manifest inventory, and source
preservation receipt matched before those rows were returned to `prepared`.
The private reconciliation scripts record IDs and results in append-only
NDJSON files beside `run.sqlite`.

The final Suna source-capture review was inspected through Daytona's direct
read API at 23:34 UTC. Of 185 blocked sandboxes, 138 were `error` with
`recoverable=true`; 21 were `error` with `recoverable=false`; 26 remained
`archiving`. The last Trimaran source sandbox remained `archiving` since
2026-09-14. An SDK “not found” response did not establish HTTP 404: the
direct API returned HTTP 200 for that sandbox. Do not grant a missing-box
waiver from the SDK error alone.

One recoverable Suna sandbox was piloted through provider recovery, stopped,
then captured with the normal workspace process. The capture verified 51
files, 53,567,536 file bytes, the archive SHA, and restoration of the source
to `stopped`. Its destination session
`bb1a4d55-bce5-40b2-babd-d7554f48e4a3` then reached `verified` on
Platinum with `workspace_api_verified_files=51`; the normal apply gate also
checked the owner, operator share, title, and history. The separate
`ai.kortix.legacy-source-recovery` LaunchAgent now
runs four concurrent recoveries. It selects the latest eligible reviews,
claims each source box, checks the provider's `recoverable` flag, recovers it,
stops it, and returns its queue row to `prepared`. A failed recovery remains
in review for at least 30 minutes before another attempt. The existing batch
runner performs capture and destination import after recovery. The dashboard
reports this worker as `sourceRecovery`.

At 23:54 UTC, Trimaran reached 613/613 verified sessions. The final source
box was still `archiving` after more than 48 hours. The user approved a
history-only import for that session. Its destination session
`3d4bd209-708b-4020-be8b-8148c4f13ff6` has four private history artifacts,
verified owner/share/history, a read-back unavailable-files notice, and a
stop receipt. The ledger records `stuck-archiving`, the direct provider state,
the source box ID, the user authorization, and `files_status=unavailable`.

The user also approved history-only imports for 47 Suna source boxes that
could not be captured. Before applying an exception, the private preflight
checks the exact source project-to-sandbox mapping, source account owner,
destination owner, direct Daytona state, and absence of a prior file capture.
The exception verifier accepts `error` with `recoverable=false` or `archiving`
with `recoverable=false` and a provider update older than 48 hours. A box that
returns to `stopped` is requeued for real file capture instead. At 23:55 UTC,
42 Suna sessions met the exception criteria: 21 stuck archiving, 19 other
unrecoverable provider errors, and two missing-volume errors. Four archiving
boxes had recent provider updates and one was restoring; they remained in
source review. The additional stopped box was requeued for capture.

The first Suna history-only pilot,
`c595bb35-43e7-4752-8398-41d77f319f66`, reached `verified` on Platinum.
Its four history artifacts, owner, operator share, native history, notice
readback, and stop receipt passed. `ai.kortix.legacy-unavailable-imports`
then started four parallel approved imports using the shared create and file
write budgets. Failed imports return to `prepared` with a retry timestamp.
`ai.kortix.legacy-unavailable-reconciler` rechecks remaining source boxes every
five minutes. Its approver requires direct provider and source mapping proof;
it captures a recovered box or marks files unavailable only under the user's
scoped authorization. Both LaunchAgents use the production dotenvx file and
the primary checkout's machine-local source credentials. Remove both with
`launchctl bootout` after all exceptions close.
