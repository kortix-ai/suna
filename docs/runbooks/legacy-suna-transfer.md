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
