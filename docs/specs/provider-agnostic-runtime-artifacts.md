# Provider-Agnostic Runtime Artifacts

Status: draft spec, 2026-05-22

## Decision

Replace the current Daytona-specific "snapshot" mental model with a provider-neutral
runtime artifact model.

Every project session boots from a runtime artifact built from:

- the project Dockerfile at a pinned commit
- the configured build context at that commit
- the Kortix runtime layer and runtime fingerprint
- a target sandbox provider

Daytona artifacts are Daytona snapshots. Local Docker artifacts are local Docker
images. Future providers such as E2B, Modal, or a microVM provider should plug into
the same artifact/build contract instead of forcing new session logic.

The local Docker path requires a standalone local builder service. The API should
enqueue and report builds. The builder service should own Docker image builds and
Docker socket access.

## Goals

- Keep Daytona working end to end.
- Add local Docker working end to end without relying on Daytona image building.
- Make runtime build state explicit in the database.
- Record which exact artifact each session booted from.
- Make the project settings UI show the actual provider artifact and build state.
- Allow future providers to implement only artifact build and sandbox create
  backends, not a new product model.
- Keep the first implementation additive enough to migrate safely from
  `project_runtime_snapshots`.

## Non-Goals

- Do not introduce a custom image registry in the first pass.
- Do not make local Docker a production isolation story. It is the local/self-host
  provider.
- Do not support arbitrary non-Dockerfile build systems in this pass.
- Do not rework project/session authorization here.

## Current State

Today the code says "snapshot" but it is already close to "runtime artifact".

Current flow:

1. Project creation calls `ensureBuildForLatestCommit(... source: "project-create")`.
2. Session creation stores `project_sessions.sandbox_provider`.
3. `provisionSessionSandbox` calls `getLatestReadySnapshot(project, branch, provider)`.
4. The selected `snapshotId` is passed into `provider.create()`.
5. `DaytonaProvider.create()` passes that snapshot to `daytona.create(...)`.

Current build path:

1. Resolve the git ref to a commit SHA.
2. Read `.kortix/Dockerfile` or `[sandbox].dockerfile`.
3. Resolve the git tree OID of `[sandbox].context`.
4. Materialize the context into `/tmp/kortix-snap-*`.
5. Copy `kortix-agent`, `kortix-entrypoint`, and `apps/sandbox/agent-cli`.
6. Compose `.kortix-snapshot.Dockerfile`.
7. Compute `contentHash = hash(dockerfile, contextTreeOid, runtimeFingerprint)`.
8. Build only via Daytona:

```ts
daytona.snapshot.create({
  name: ctx.snapshotName,
  image: Image.fromDockerfile(ctx.composedPath),
})
```

Current storage:

```text
project_runtime_snapshots(
  snapshot_row_id uuid pk,
  account_id uuid,
  project_id uuid,
  provider sandbox_provider,
  commit_sha text,
  branch text,
  snapshot_id text,
  status queued | building | ready | failed,
  error text,
  metadata jsonb,
  created_at timestamptz,
  updated_at timestamptz
)

unique(project_id, commit_sha, provider)
```

Current UI:

- `GET /v1/projects/:projectId/snapshots` returns build rows plus default branch
  HEAD.
- `SandboxSnapshotCard` compares `head_commit_sha` to latest ready `commit_sha`.
- The card is present in project settings, but it is Daytona-worded and provider
  implicit.

## Problems To Fix

1. `snapshot_id` is provider-specific.

   For Daytona it is a Daytona snapshot name. For local Docker it would be an
   image reference. Treating both as "snapshot" leaks Daytona into the product.

2. Build rows and artifacts are conflated.

   A build attempt is not the same thing as the artifact it produces. Multiple
   branch refs or commits can reuse the same content-addressed artifact.

3. Branch lookup can miss an already-built artifact.

   A row is unique on `(project_id, commit_sha, provider)` but session boot looks
   up ready rows by `(project_id, branch, provider)`. If branch B points at a
   commit already built for branch A, there may be no branch B row even though
   the artifact exists.

4. The builder is not provider-pluggable.

   The preparation step is shared, but `runBuild()` hard-fails for anything other
   than Daytona.

5. The API does build work in-process.

   Daytona can hide build cost in its service. Local Docker cannot. A local Docker
   flow needs a worker that can run Docker builds, stream logs, and own the Docker
   socket.

6. Session rows do not have an artifact relation.

   `session_sandboxes` records provider external ID and metadata, but there is no
   first-class FK to the runtime artifact that was booted.

7. Status is under-specified.

   The current status call returns rows plus HEAD. The UI computes important
   product state client-side and cannot explain provider, artifact type, local
   Docker image ref, build logs, or whether a ready artifact exists but the branch
   row is absent.

## Terminology

- Runtime artifact: provider-specific bootable output for a project runtime.
  Examples: Daytona snapshot, local Docker image.
- Runtime build: one attempt to prepare or produce a runtime artifact for a
  project, provider, ref, and commit.
- Artifact backend: provider-specific implementation that builds, verifies, and
  deletes artifacts.
- Sandbox provider: provider-specific implementation that starts, stops, removes,
  and resolves endpoints for running sessions.

## Target Architecture

```text
project/session routes
  |
  v
runtime artifact service
  - resolve ref
  - prepare build inputs
  - find/reuse artifact by content hash
  - enqueue build when missing
  - compute project status
  |
  v
project_runtime_builds table  <---- runtime builder worker
                                  - claims jobs
                                  - materializes context
                                  - runs artifact backend
                                  - writes artifact rows
                                  - writes build events/logs

session sandbox service
  |
  v
sandbox provider
  - receives runtimeArtifact, not snapshot string
  - Daytona uses artifact.providerArtifactRef as snapshot name
  - local Docker uses artifact.providerArtifactRef as image ref
```

## Proposed Data Model

Add new tables instead of mutating `project_runtime_snapshots` in place. Backfill
and keep compatibility endpoints during rollout.

### `project_runtime_artifacts`

One row per bootable provider artifact.

```text
project_runtime_artifacts(
  artifact_id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(account_id) on delete cascade,
  project_id uuid not null references projects(project_id) on delete cascade,

  provider sandbox_provider not null,
  artifact_type text not null,
    -- "daytona_snapshot" | "docker_image" | "microvm_image" | future
  provider_artifact_ref text not null,
    -- Daytona snapshot name, Docker image ref, etc.

  content_hash text not null,
  short_hash text not null,
  runtime_fingerprint text not null,
  dockerfile_path text not null,
  context_path text not null,
  context_tree_oid text not null,

  created_from_commit_sha text not null,
  created_from_build_id uuid null,
  metadata jsonb not null default '{}',

  last_used_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)
```

Indexes:

```text
unique(project_id, provider, content_hash)
unique(provider, provider_artifact_ref)
index(project_id, provider, created_at)
index(project_id, provider, runtime_fingerprint)
```

Notes:

- `content_hash` is provider-independent. The same inputs should resolve to the
  same hash for Daytona and local Docker.
- `provider_artifact_ref` is provider-specific and should never be parsed by
  product code.
- `artifact_type` makes UI/status explicit.

### `project_runtime_builds`

One row per build request or attempt.

```text
project_runtime_builds(
  build_id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(account_id) on delete cascade,
  project_id uuid not null references projects(project_id) on delete cascade,

  provider sandbox_provider not null,
  source text not null,
    -- "project-create" | "session-start" | "manual" | "webhook" | future
  requested_by_user_id uuid null,

  ref_name text not null,
  commit_sha text not null,

  dockerfile_path text null,
  context_path text null,
  context_tree_oid text null,
  content_hash text null,
  runtime_fingerprint text null,

  status text not null,
    -- "queued" | "preparing" | "building" | "ready" | "failed" | "canceled"
  artifact_id uuid null references project_runtime_artifacts(artifact_id),

  error text null,
  started_at timestamptz null,
  finished_at timestamptz null,
  lease_owner text null,
  lease_expires_at timestamptz null,
  metadata jsonb not null default '{}',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)
```

Indexes:

```text
index(project_id, provider, ref_name, created_at)
index(project_id, provider, commit_sha)
index(project_id, provider, status)
index(provider, status, created_at)
unique(project_id, provider, ref_name, commit_sha, runtime_fingerprint)
```

The unique index may need to be partial because `runtime_fingerprint` is null
until preparation finishes. If so:

```text
unique(project_id, provider, ref_name, commit_sha)
  where status in ('queued', 'preparing', 'building')

unique(project_id, provider, ref_name, commit_sha, runtime_fingerprint)
  where runtime_fingerprint is not null
```

Notes:

- Builds are the branch/ref history.
- Artifacts are the reusable boot outputs.
- A build can finish instantly by linking to an existing artifact with matching
  content hash. This fixes the branch reuse issue.

### `project_runtime_build_events`

Optional in the first pass, but useful for local Docker because local builds can
fail in ways users need to inspect.

```text
project_runtime_build_events(
  event_id uuid primary key default gen_random_uuid(),
  build_id uuid not null references project_runtime_builds(build_id) on delete cascade,
  sequence integer not null,
  level text not null,
    -- "debug" | "info" | "warn" | "error"
  message text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
)

unique(build_id, sequence)
index(build_id, created_at)
```

### `session_sandboxes` additions

```text
runtime_artifact_id uuid null references project_runtime_artifacts(artifact_id),
runtime_build_id uuid null references project_runtime_builds(build_id)
```

This is load-bearing. Every running session should be able to answer:

- which provider started it
- which provider resource is running
- which runtime artifact it booted from
- which build produced or selected that artifact
- which commit/ref that artifact represents

## Provider Interfaces

### Artifact Backend

```ts
export type RuntimeArtifactType =
  | 'daytona_snapshot'
  | 'docker_image'
  | 'microvm_image';

export interface PreparedRuntimeContext {
  contextDir: string;
  dockerfilePath: string;
  contentHash: string;
  shortHash: string;
  runtimeFingerprint: string;
  dockerfilePathInRepo: string;
  contextPathInRepo: string;
  contextTreeOid: string;
}

export interface RuntimeArtifactResult {
  artifactType: RuntimeArtifactType;
  providerArtifactRef: string;
  metadata: Record<string, unknown>;
}

export interface RuntimeArtifactBackend {
  readonly provider: SandboxProviderName;

  exists(ref: string): Promise<boolean>;
  build(input: {
    projectId: string;
    accountId: string;
    buildId: string;
    commitSha: string;
    prepared: PreparedRuntimeContext;
    onLog?: (event: { level: string; message: string; metadata?: Record<string, unknown> }) => void;
  }): Promise<RuntimeArtifactResult>;
  verify(ref: string): Promise<boolean>;
  remove(ref: string): Promise<void>;
}
```

### Sandbox Provider

Change `CreateSandboxOpts` from `snapshot?: string` to a runtime artifact object.
Keep `snapshot` temporarily as a compatibility alias during migration.

```ts
export interface RuntimeArtifactRef {
  artifactId: string;
  provider: SandboxProviderName;
  artifactType: RuntimeArtifactType;
  providerArtifactRef: string;
  contentHash: string;
  commitSha: string;
}

export interface CreateSandboxOpts {
  accountId: string;
  userId: string;
  name: string;
  envVars?: Record<string, string>;
  serverType?: string;
  location?: string;
  runtimeArtifact: RuntimeArtifactRef;
}
```

Provider behavior:

- Daytona reads `runtimeArtifact.providerArtifactRef` as the Daytona snapshot name.
- Local Docker reads `runtimeArtifact.providerArtifactRef` as the Docker image ref.
- Product code should not branch on artifact type during session creation.

## Runtime Builder Service

Introduce a standalone builder process. It can live in the API package initially
as a separate entrypoint, but it must run as its own service in local compose.

Suggested package/entrypoint:

```text
apps/api/src/runtime-builder/index.ts
pnpm --filter kortix-api runtime-builder
```

Local compose service:

```yaml
runtime-builder:
  image: kortix/kortix-api:dev
  command: pnpm --filter kortix-api runtime-builder
  environment:
    ALLOWED_SANDBOX_PROVIDERS: local_docker
    KORTIX_RUNTIME_BUILDER_PROVIDERS: local_docker
    LOCAL_DOCKER_IMAGE_PREFIX: kortix/runtime
    DOCKER_HOST: unix:///var/run/docker.sock
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock
```

Security rule:

- Mounting the Docker socket is local/self-host only.
- Never mount the Docker socket in Kortix cloud API containers.
- If cloud ever supports Docker builds outside Daytona, run them on dedicated
  builder hosts with strict isolation, not inside the public API process.

Worker loop:

1. Claim queued builds using a lease.
2. Mark build `preparing`.
3. Resolve manifest and sandbox paths at the target commit.
4. Materialize context.
5. Copy Kortix runtime artifacts.
6. Compose the Dockerfile.
7. Compute content hash and runtime fingerprint.
8. Check for an existing ready `project_runtime_artifacts` row by
   `(project_id, provider, content_hash)`.
9. If found and `backend.verify(ref)` succeeds, mark build `ready` and link it.
10. If missing, mark build `building` and run backend build.
11. Insert artifact row.
12. Mark build `ready`, link artifact.
13. Prune old builds/artifacts in the background.
14. Always remove temporary context directories.

Lease fields:

- `lease_owner` should be a stable process ID, host name, or generated worker ID.
- `lease_expires_at` should be refreshed while a build is active.
- A queued/preparing/building build with an expired lease can be reclaimed.

## Daytona Artifact Backend

Input:

- composed Dockerfile path
- context directory
- generated artifact name, e.g. `kortix-artifact-{projectShort}-{shortHash}`

Build:

```ts
await daytona.snapshot.create(
  { name: artifactName, image: Image.fromDockerfile(prepared.dockerfilePath) },
  { timeout: BUILD_TIMEOUT_SECONDS },
)
```

Artifact:

```text
artifact_type = "daytona_snapshot"
provider_artifact_ref = artifactName
```

Verify:

```ts
await daytona.snapshot.get(providerArtifactRef)
```

Delete:

```ts
const snapshot = await daytona.snapshot.get(providerArtifactRef)
await daytona.snapshot.delete(snapshot)
```

Notes:

- Existing Daytona behavior should move behind this backend.
- Existing `project_runtime_snapshots.snapshot_id` maps to
  `project_runtime_artifacts.provider_artifact_ref`.
- Existing session provider behavior stays nearly identical, except it receives
  a runtime artifact object instead of `snapshot`.

## Local Docker Artifact Backend

Input:

- composed Dockerfile path
- context directory
- image prefix
- generated image ref

Image ref:

```text
${LOCAL_DOCKER_IMAGE_PREFIX}:${projectShort}-${shortHash}
```

Example:

```text
kortix/runtime:9f2a1c3d-0c12ab98d021
```

Build command:

```bash
docker build \
  -f "$CONTEXT/.kortix-snapshot.Dockerfile" \
  -t "$IMAGE_REF" \
  --label io.kortix.project_id="$PROJECT_ID" \
  --label io.kortix.account_id="$ACCOUNT_ID" \
  --label io.kortix.build_id="$BUILD_ID" \
  --label io.kortix.commit_sha="$COMMIT_SHA" \
  --label io.kortix.content_hash="$CONTENT_HASH" \
  --label io.kortix.runtime_fingerprint="$RUNTIME_FINGERPRINT" \
  "$CONTEXT"
```

Prefer BuildKit when available:

```bash
DOCKER_BUILDKIT=1 docker build ...
```

If `docker buildx` is available, a later optimization can use:

```bash
docker buildx build --load ...
```

Artifact:

```text
artifact_type = "docker_image"
provider_artifact_ref = imageRef
metadata.image_id = docker inspect image id
metadata.repo_digests = docker inspect repo digests
```

Verify:

```bash
docker image inspect "$IMAGE_REF"
```

Delete:

```bash
docker image rm "$IMAGE_REF"
```

Local Docker sandbox create:

```bash
docker run -d \
  --name "kortix-session-${sandboxId}" \
  --label io.kortix.session_id="$SESSION_ID" \
  --label io.kortix.project_id="$PROJECT_ID" \
  --label io.kortix.runtime_artifact_id="$ARTIFACT_ID" \
  --network "$KORTIX_DOCKER_NETWORK" \
  -p "127.0.0.1::8000" \
  --env KORTIX_API_URL="$SANDBOX_API_BASE" \
  --env ENV_MODE="local" \
  --env INTERNAL_SERVICE_KEY="$SERVICE_KEY" \
  --env TUNNEL_API_URL="$SANDBOX_API_BASE" \
  --env TUNNEL_TOKEN="$SERVICE_KEY" \
  ...user/session env vars... \
  "$IMAGE_REF"
```

Endpoint resolution:

- Inspect container port binding for container port `8000`.
- Return `http://127.0.0.1:{hostPort}` with `Authorization: Bearer {serviceKey}`.
- The API proxy can continue using `resolveEndpoint(externalId)` so frontend
  call sites stay provider-neutral.

`external_id`:

- Store the Docker container ID or stable container name.
- Recommended: store container ID in `external_id` and container name in metadata.

Required local env:

```text
ALLOWED_SANDBOX_PROVIDERS=local_docker,daytona
KORTIX_RUNTIME_BUILDER_PROVIDERS=local_docker
LOCAL_DOCKER_IMAGE_PREFIX=kortix/runtime
KORTIX_DOCKER_NETWORK=kortix-local
SANDBOX_PORT_BASE=14000
```

Linux host API access:

- Prefer running API and sandbox containers on the same Docker network.
- If the API runs on the host, use the Docker bridge gateway or a configured
  `KORTIX_LOCAL_SANDBOX_API_BASE`.

macOS host API access:

- `host.docker.internal` is acceptable for local development.

## Build Resolution Algorithm

Session start should not directly think in "latest snapshot by branch". It should
ask for a ready artifact for `(project, provider, ref)`.

```ts
async function resolveRuntimeArtifactForSession(input) {
  const commitSha = await resolveCommitSha(project, ref)

  const preparedInputs = await prepareRuntimeInputs(project, commitSha)
  const contentHash = preparedInputs.contentHash

  const artifact = await findReadyArtifact(projectId, provider, contentHash)
  if (artifact && await backend.verify(artifact.providerArtifactRef)) {
    await ensureReadyBuildRowForRef({
      projectId,
      provider,
      refName: ref,
      commitSha,
      artifactId: artifact.artifactId,
      preparedInputs,
      source,
    })
    return artifact
  }

  const build = await enqueueBuildIfNeeded({
    projectId,
    provider,
    refName: ref,
    commitSha,
    preparedInputs,
    source,
  })

  if (input.waitForReady) {
    return await waitForReadyArtifact(build.buildId)
  }

  return { queued: build }
}
```

Important behavior:

- If a ready artifact exists for the same content hash, do not rebuild.
- If a build is already queued/building for the same ref and commit, return it.
- If a build is queued/building for another branch but the same content hash is
  not yet known, do not block on hidden assumptions. It is acceptable to enqueue
  another row, then dedupe after preparation.
- Always read `[sandbox]` paths from the target commit, not default branch HEAD.

## API Contract

Keep compatibility endpoints temporarily:

- `GET /v1/projects/:projectId/snapshots`
- `POST /v1/projects/:projectId/snapshots/rebuild`

Add provider-neutral endpoints:

### `GET /v1/projects/:projectId/runtime-artifacts`

Query:

```text
provider optional, default config.getDefaultProvider()
ref optional, default project.defaultBranch
```

Response:

```json
{
  "project_id": "uuid",
  "default_ref": "main",
  "selected_ref": "main",
  "selected_provider": "local_docker",
  "providers": [
    {
      "provider": "daytona",
      "enabled": true,
      "artifact_type": "daytona_snapshot"
    },
    {
      "provider": "local_docker",
      "enabled": true,
      "artifact_type": "docker_image"
    }
  ],
  "head_commit_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "head_resolve_error": null,
  "status": "ready",
  "needs_build": false,
  "reason": null,
  "current_artifact": {
    "artifact_id": "uuid",
    "artifact_type": "docker_image",
    "provider_artifact_ref": "kortix/runtime:9f2a1c3d-0c12ab98d021",
    "content_hash": "0c12ab98d021...",
    "runtime_fingerprint": "sha256...",
    "created_from_commit_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "last_used_at": "2026-05-22T..."
  },
  "latest_build": {
    "build_id": "uuid",
    "status": "ready",
    "ref_name": "main",
    "commit_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "artifact_id": "uuid",
    "error": null,
    "created_at": "2026-05-22T...",
    "updated_at": "2026-05-22T..."
  },
  "in_flight_build": null,
  "recent_builds": [],
  "recent_artifacts": []
}
```

`status` values:

```text
not_built
queued
preparing
building
ready
failed
unknown
```

`reason` values:

```text
no_artifact
head_changed
runtime_changed
provider_disabled
head_resolve_failed
build_failed
artifact_missing
```

### `POST /v1/projects/:projectId/runtime-artifacts/build`

Body:

```json
{
  "provider": "local_docker",
  "ref": "main",
  "force": false
}
```

Response:

```json
{
  "status": "started",
  "build_id": "uuid",
  "provider": "local_docker",
  "ref": "main",
  "commit_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

Statuses:

```text
already-ready
already-building
started
failed-to-start
```

### `GET /v1/projects/:projectId/runtime-builds/:buildId/events`

Returns build logs/events for UI inspection.

## Session Boot Contract

Before provider create:

1. Resolve or enqueue runtime artifact for the session's `baseRef` and provider.
2. If no ready artifact exists, keep the session in provisioning while build runs.
3. If the wait budget expires, mark session failed with a clear build message.
4. If ready, pass the runtime artifact to provider create.

After provider create:

- Update `session_sandboxes.runtime_artifact_id`.
- Update `session_sandboxes.runtime_build_id` when known.
- Update artifact `last_used_at`.
- Store provider-specific runtime metadata only in metadata, not as product logic.

`session_sandboxes.metadata` should still carry helpful denormalized values:

```json
{
  "runtimeArtifact": {
    "artifactType": "docker_image",
    "providerArtifactRef": "kortix/runtime:...",
    "contentHash": "...",
    "commitSha": "..."
  }
}
```

## Project Settings UI

Rename the card from "Sandbox snapshot" to "Runtime image" or "Runtime artifact".

Display:

- selected provider
- enabled provider list
- branch/ref HEAD
- latest ready artifact
- in-flight build
- last build error
- exact artifact ref
  - Daytona: snapshot name
  - Local Docker: image ref
- runtime fingerprint short value
- Dockerfile path and context path
- rebuild/build button
- build logs link

Provider tabs:

```text
Daytona
Local Docker
```

Copy should avoid provider-specific claims:

- Bad: "Every session boots from this project's Daytona snapshot."
- Good: "Every session boots from a project runtime image built from the selected
  provider, Dockerfile, context, and Kortix runtime layer."

Session detail should show:

- provider
- external runtime ID
- runtime artifact ref
- commit SHA
- build ID

## Retention And Garbage Collection

Retention must operate on builds and artifacts separately.

Build retention:

- Keep latest N build rows per `(project, provider, ref_name)`.
- Keep failed rows for at least a short diagnostic window.
- Do not delete build rows referenced by `session_sandboxes.runtime_build_id`.

Artifact retention:

- Keep artifacts referenced by any build row.
- Keep artifacts referenced by any session sandbox row.
- Delete provider artifacts only after DB references are gone and provider
  `verify()` still finds the artifact.

Daytona deletion:

- Delete Daytona snapshots with `daytona.snapshot.delete(...)`.

Local Docker deletion:

- Delete local Docker images with `docker image rm`.
- Only delete images labelled `io.kortix.project_id` and matching the artifact
  table, never arbitrary user images.

Temporary directories:

- Always remove materialized build contexts after success or failure.
- A periodic cleanup can remove stale `/tmp/kortix-runtime-*` directories older
  than one day.

## Migration Plan

Phase 1: Additive schema.

- Add `project_runtime_artifacts`.
- Add `project_runtime_builds`.
- Add optional `project_runtime_build_events`.
- Add `runtime_artifact_id` and `runtime_build_id` to `session_sandboxes`.
- Keep `project_runtime_snapshots` untouched.

Phase 2: Backfill Daytona rows.

For each `project_runtime_snapshots` row:

- Create a `project_runtime_builds` row.
- If `snapshot_id` is non-null and status is `ready`, create or reuse a
  `project_runtime_artifacts` row:
  - `artifact_type = "daytona_snapshot"`
  - `provider_artifact_ref = snapshot_id`
  - `content_hash = metadata.contentHash` if present, otherwise a derived
    compatibility hash using `snapshot_id`
  - `runtime_fingerprint = metadata.runtimeFingerprint` if present
- Link build to artifact.

If a row is `ready` but has `error`, treat it as suspicious:

- Prefer mapping to `failed` unless a provider verify call confirms the artifact.
- Record the original state in metadata.

Phase 3: Read from new model.

- Update status service to read new tables.
- Keep `/snapshots` endpoints as aliases backed by new tables.
- Update UI wording to "Runtime image".

Phase 4: Builder worker.

- Move Daytona build path behind `RuntimeArtifactBackend`.
- Add local Docker backend.
- Add runtime-builder service.
- API enqueues builds only.

Phase 5: Provider create.

- Change providers to accept `runtimeArtifact`.
- Update Daytona provider.
- Add LocalDockerProvider.
- Link session sandbox rows to artifacts/builds.

Phase 6: Remove old table.

- Only after compatibility has shipped and migrations are verified.
- Delete `project_runtime_snapshots` reads/writes.

## Local Docker End-to-End Flow

1. User starts local stack.
2. `runtime-builder` is running and has Docker socket access.
3. `ALLOWED_SANDBOX_PROVIDERS` includes `local_docker`.
4. User creates/imports project.
5. API enqueues runtime build for default branch and local Docker.
6. Builder claims build.
7. Builder prepares context and composed Dockerfile.
8. Builder builds `kortix/runtime:{projectShort}-{shortHash}` locally.
9. Builder writes artifact row with `artifact_type = "docker_image"`.
10. Project settings shows "Ready" and the Docker image ref.
11. User starts a session.
12. Session service resolves ready artifact for `baseRef`.
13. LocalDockerProvider runs a container from the image.
14. API records container ID in `session_sandboxes.external_id`.
15. API records artifact/build FKs in `session_sandboxes`.
16. Endpoint resolution inspects container port 8000 and proxies to it.
17. Health checks validate `kortix-agent` and OpenCode readiness.
18. Restart removes old container and starts a new one from the latest ready
    artifact, building first if needed.

## Failure Modes

Docker daemon unavailable:

- Build fails with `provider_unavailable`.
- UI says Docker is not reachable and shows the exact daemon error.

Docker build fails:

- Build row becomes `failed`.
- Logs are visible.
- Session waiting for first artifact fails with "Runtime image build failed".

Artifact row exists but provider artifact is missing:

- `verify()` fails.
- Status returns `artifact_missing`.
- Rebuild button enqueues a new build.

Builder dies mid-build:

- Lease expires.
- Another builder can reclaim the row.
- If reclaim is unsafe for local Docker, mark previous attempt failed and enqueue
  a fresh attempt.

Docker socket mounted in cloud by mistake:

- Startup should fail closed when `INTERNAL_KORTIX_ENV=prod` and
  `KORTIX_RUNTIME_BUILDER_PROVIDERS` includes `local_docker` without an explicit
  `KORTIX_ALLOW_PROD_DOCKER_BUILDER=true`.

## Test Plan

Unit tests:

- runtime hash stays stable for identical inputs
- runtime hash changes on Dockerfile/context/runtime change
- branch B can reuse an artifact built for branch A at the same content hash
- ready artifact missing in provider returns `artifact_missing`
- local Docker command builder labels and tags correctly
- Daytona backend maps artifact ref to snapshot name
- build lease claim/reclaim behavior

API tests:

- `GET /runtime-artifacts` returns selected provider, current artifact, in-flight
  build, and needs_build reason
- `POST /runtime-artifacts/build` returns `already-ready`, `already-building`,
  or `started`
- compatibility `/snapshots` endpoint still works
- rebuild requires manage permission
- session sandbox response includes runtime artifact metadata

Local Docker integration tests:

- build a minimal project image locally
- run a session container from the built image
- `GET /kortix/health` succeeds through provider endpoint resolution
- restart removes old container and starts a new one
- second session reuses existing Docker image without rebuilding
- forced rebuild creates a new build row and updates artifact when content changes

Daytona integration tests:

- existing Daytona snapshot flow still builds and boots
- status endpoint shows `artifact_type = "daytona_snapshot"`
- retention deletes unreferenced Daytona snapshots only

Browser smoke:

- project settings shows provider-specific artifact refs
- build progress auto-refreshes
- failed local Docker build shows logs and retry
- session page reaches running state from a local Docker artifact

## Rollout Order

1. Add new tables and read models.
2. Add status service and new provider-neutral API.
3. Update settings UI wording and status rendering.
4. Move Daytona build into artifact backend with no behavior change.
5. Add runtime-builder worker and run Daytona builds through it where possible.
6. Add local Docker artifact backend.
7. Add LocalDockerProvider sandbox runtime.
8. Wire local compose and scripts.
9. Run local Docker E2E.
10. Keep `/snapshots` alias until UI and clients are fully migrated.

## Open Questions

1. Should local Docker images be tagged only by content hash, or by
   project-short plus content hash?

   Recommendation: project-short plus content hash for readability and easier
   local cleanup.

2. Should local Docker provider be enabled by default in `pnpm dev`?

   Recommendation: yes, when Docker is reachable. Daytona can still be enabled
   as a cloud provider option.

3. Should the first local Docker builder use Docker CLI or Dockerode?

   Recommendation: CLI first. It is simpler to debug, streams logs naturally,
   and avoids SDK edge cases. Wrap it behind a small interface so Dockerode can
   replace it later if needed.

4. Should build status be one table or artifacts plus builds?

   Recommendation: two tables. Artifacts and build attempts are different
   entities, and local Docker makes that distinction visible.

5. Should sessions wait for local builds?

   Recommendation: first session can wait up to the existing snapshot wait
   budget, but UI must clearly show "building runtime image locally". Later,
   project creation and push hooks should prebuild so sessions usually do not
   wait.
