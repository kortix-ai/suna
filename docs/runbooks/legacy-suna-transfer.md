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

The following stages are a design, not implemented apply commands:

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

## Rehearsal and GO gates

A local export rehearsal is read-only and can run now. A full rehearsal creates
new destination resources and can start archived source sandboxes; it is a
separate operation requiring execution authorization.

GO remains blocked until all of these have evidence:

- Source ownership map and destination memberships are resolved.
- Private files have a persistence design that does not expose them in shared Git.
- Every source row and file is captured or has an approved exception.
- Latest-runtime native import, attachment rendering, continuation, and restart pass.
- Owner access and unauthorized-user denial pass through the real API and UI.
- The apply implementation supports interruption, retry, duplicates, and rollback.
- Capacity, concurrency, source consistency, and cutover window are recorded.
- The exact manifest and execution command receive approval.

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
