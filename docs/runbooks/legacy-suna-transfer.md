# Prepare a legacy Suna transfer

The existing Suna migration imports a subset of an account into a new project.
It is not a lossless, cross-instance migration. Do not use its `--apply` mode
for a full transfer from a self-hosted source.

The preparation CLI below reads the source Data API and Storage API. It has no
destination client or apply command. It never starts or modifies a sandbox.

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
- The destination session uses that user's ID as `created_by`, not the source
  account ID, operator ID, or destination account ID.
- Private sessions stay private. Public/shared records need an explicit sharing
  decision; do not silently broaden access.
- Missing destination identities remain unresolved until provisioned or mapped.
  Do not send invitation mail as an incidental side effect of copying data.
- Scope deterministic IDs by source Supabase ref, entity kind, and source ID.
  Development databases can share source IDs with production copies.
- Account/project membership and session ownership are separate. Validate both.
- Private session visibility does not establish Git branch privacy. The Git
  proxy forwards clone/fetch after project authorization. Do not put private
  workspaces or raw conversations in a shared repository and assume private
  session flags protect them.

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
bun test apps/api/src/scripts/legacy-transfer/source.test.ts
pnpm test
```

Run the focused command from the repository root. Exercise the CLI as a real
process against a bounded source thread and compare source and ledger counts.
Do not call a local export a successful destination migration.

Storage API reference:
https://github.com/supabase/storage/blob/master/src/http/routes/object/listObjectsV2.ts
