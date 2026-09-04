/**
 * The provisioning core behind `POST /v1/projects/provision`, extracted so a
 * second (streaming) route can share it instead of forking a second copy of
 * "make a repo, insert a row, seed it, roll back on failure". Two
 * implementations of that flow would diverge, and the one that diverges is
 * the one that leaves orphaned upstream repos.
 *
 * `runProvision` returns a plain `{ status, body }` instead of calling
 * `c.json(...)` directly, so it has no Hono-response dependency and either
 * route can turn the result into whatever wire format it needs (a single
 * JSON response for `/provision`, an SSE event for the streaming route).
 *
 * `emit` reports PHASES, not partial results. The JSON route ignores it — its
 * response shape is a contract (the CLI and `@kortix/sdk` depend on it) and
 * must not change. The streaming route (next) is the only real consumer.
 */
import {
  defaultManagedProviderId,
  getBackend,
  hasBackend,
  isRetiredManagedProvider,
  parseBasicAuthHeader,
  type GitConnectionRef,
} from './git-backends';
import {
  ManagedRepoSeedError,
  buildManagedRepoSeedState,
  pushSeedFiles,
  pushVerifiedSeed,
} from './managed-repo-seed';
import { normalizeStarterTemplateId } from './starter';
import {
  buildProjectSeedFiles,
  buildProjectSeedFilesFromItem,
  defaultAgentFromSeedFiles,
  normalizeMarketplaceItems,
} from './seed-files';
import { getCatalogItemDetail } from '../marketplace/catalog';
import { remoteBranchExists } from './git';
import { config } from '../config';
import { db } from '../shared/db';
import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  enforceProjectQuota,
  getProjectMemberRole,
  grantProjectRole,
  resolveProjectAccount,
} from './lib/access';
import {
  buildConnectionRef,
  getProjectGitConnection,
  getProjectGitRemote,
  resolveProjectGitAuth,
  upsertProjectGitConnection,
} from './lib/git';
import { metadataMerge } from './lib/metadata-merge';
import {
  buildCachedFastBootGitHint,
  resolveFastBootGitHintWithCache,
} from './lib/fast-boot-git-hint';
import {
  classifyProvisionReplay,
  findIdempotentProvision,
  isProvisionIdempotencyConflict,
  lookupProvisionByIdempotencyKey,
  provisionReplayResponse,
  readProvisionIdempotencyKey,
} from './lib/provision-idempotency';
import { normalizeProjectGlyph } from './lib/project-glyph';
import { normalizeProjectIcon } from './lib/project-icon';
import { PROJECT_NAME_MAX_LENGTH, normalizeString, readBody, serializeProject } from './lib/serializers';
import { setContextField } from '../lib/request-context';
import { kickProjectTemplatePrebuilds } from '../snapshots/builder';
import type { AccountRole, ProjectRole } from './access';

export const PROVISION_PHASES = [
  'validating',
  'creating_repository',
  'registering',
  'seeding',
] as const;

export type ProvisionPhase = (typeof PROVISION_PHASES)[number];
export type ProvisionEmit = (phase: ProvisionPhase) => void;

const FAST_BOOT_SEED_HINT_TIMEOUT_MS = 8_000;

/**
 * The exact status codes `runProvision` can produce, matching both routes'
 * declared OpenAPI responses (`201` + `errors(400, 403, 409, 502, 503)`).
 * Kept as a literal union, not `number`, so `c.json(result.body,
 * result.status)` is checked against the route's declared responses instead
 * of a route silently casting the mismatch away with `as never`. 403 is
 * produced here too — `enforceProjectQuota` (`lib/access.ts`) returns a raw
 * `c.json({...}, 403)` `Response` when the account is at its project limit,
 * not only from each route's own pre-`runProvision` `authorize()` gate.
 */
export type ProvisionResultStatus = 201 | 400 | 403 | 409 | 502 | 503;

export interface ProvisionResult {
  status: ProvisionResultStatus;
  body: unknown;
}

export interface ProvisionContext {
  /**
   * Hono request context. Kept, rather than reshaped, ONLY so
   * `enforceProjectQuota(c, accountId)` can stay byte-identical — it already
   * returns a ready-made `Response`, which `runProvision` unwraps into a
   * `ProvisionResult` below.
   */
  c: any;
  body: Record<string, unknown>;
  scope: { userId: string; accountId: string; accountRole: AccountRole };
}

/**
 * Reads the request body and resolves the caller's account scope — the part
 * of the old `POST /provision` handler that runs BEFORE the
 * `PROJECT_CREATE` authorization check. Kept out of `runProvision` itself so
 * a caller (either route) can still 403 before any provisioning work starts.
 */
export async function buildProvisionContext(c: any): Promise<ProvisionContext> {
  const body = await readBody(c);
  const scope = await resolveProjectAccount(c, body);
  return { c, body, scope };
}

/**
 * The caller's REAL access on a project that POST /provision is replaying.
 *
 * The create path can hard-code `manager` because it has just called
 * `grantProjectRole`. A replay cannot: that grant is written only on the create
 * path, so a second account admin replaying another admin's key holds no
 * `project_members` row at all. `projectRole` is therefore looked up rather
 * than assumed.
 *
 * `effectiveRole` is `manager` by derivation, not by assumption: reaching a
 * replay required `authorize(…, ACCOUNT_ACTIONS.PROJECT_CREATE)` to pass, which
 * means the caller is an owner or admin of the account, and `lib/access.ts`
 * maps owner/admin to `manager` regardless of the project grant.
 */
async function provisionReplayAccess(
  projectId: string,
  userId: string,
): Promise<{ projectRole: ProjectRole | null; effectiveRole: ProjectRole }> {
  return {
    projectRole: await getProjectMemberRole(projectId, userId),
    effectiveRole: 'manager',
  };
}

// Managed-git "Create project": provisions a repo on the managed backend +
// scoped per-project push token, optionally seeds the starter (web flow), and
// registers the project.
// Used by the web "Create project" button and `kortix ship` when a working tree
// has no `origin` remote. BYO-repo projects go through POST / and /create-repo.
export async function runProvision(ctx: ProvisionContext, emit: ProvisionEmit): Promise<ProvisionResult> {
  emit('validating');
  const { c, body, scope } = ctx;

  // Managed-git provider, provider-agnostic via the backend registry. GitHub is
  // the default + only active managed backend. Forgejo / Artifacts slot in here
  // as drop-ins.
  //
  // `defaultManagedProviderId()` — never `process.env.MANAGED_GIT_PROVIDER`
  // directly: a retired backend must not be selectable by a deployed env bundle
  // (see registry.ts). A caller naming one explicitly is refused for the same
  // reason; EXISTING repos on it keep working through their connection row.
  const provider = normalizeString(body.provider) ?? defaultManagedProviderId();
  if (!hasBackend(provider)) {
    return { status: 400, body: { error: `Unsupported managed git provider "${provider}"` } };
  }
  if (isRetiredManagedProvider(provider)) {
    return {
      status: 400,
      body: {
        error: `Managed git provider "${provider}" is retired — new repositories are provisioned on github`,
      },
    };
  }
  const backend = getBackend(provider);
  if (!(await backend.isConfigured())) {
    return {
      status: 503,
      body: { error: `Managed git provider "${provider}" is not configured on this server` },
    };
  }

  const name = normalizeString(body.name) ?? normalizeString(body.project_name ?? body.projectName);
  if (!name) return { status: 400, body: { error: 'name is required' } };
  if (!/^[a-zA-Z0-9._ -]+$/.test(name)) {
    return {
      status: 400,
      body: { error: 'name must contain only letters, numbers, spaces, hyphens, underscores or dots' },
    };
  }
  // The column is varchar(255); without this check an over-long name (users
  // paste whole task prompts here) passes the charset regex, provisions the
  // upstream repo, then dies on the DB insert — a 500 plus an orphaned managed
  // repo per retry. Reject BEFORE anything is created upstream.
  if (name.length > PROJECT_NAME_MAX_LENGTH) {
    return {
      status: 400,
      body: { error: `name must be ${PROJECT_NAME_MAX_LENGTH} characters or fewer` },
    };
  }

  // Caller-supplied dedupe token. Parsed with the other request validation —
  // a malformed key is a 400, never a silent downgrade to "no key", because a
  // caller that believes it is protected against duplicates must not be
  // quietly unprotected. The LOOKUP happens further down, next to the quota
  // check and before anything exists upstream.
  const idempotency = readProvisionIdempotencyKey(body);
  if (!idempotency.ok) return { status: 400, body: { error: idempotency.error } };
  const idempotencyKey = idempotency.key;

  // Optional per-project emoji from the create-project modal. Invalid values
  // degrade to no icon rather than failing the create — the project matters,
  // the decoration does not.
  const icon = normalizeProjectIcon(body.icon);

  // Same degrade-don't-fail rule as the icon above. If both arrive, the glyph
  // wins and the emoji is dropped — a project shows one icon, and picking the
  // winner here keeps the INSERT free of the delete-the-other logic that the
  // PATCH path needs.
  const iconGlyph = normalizeProjectGlyph(body.icon_glyph);

  // "Clone project" — seed the new repo from a `registry:project` marketplace
  // item instead of the blank starter. Resolved + type-checked BEFORE any
  // upstream repo/DB row is created, same as the name checks above.
  const sourceItemId = normalizeString(body.source_item_id ?? body.sourceItemId);
  if (sourceItemId) {
    const sourceItem = await getCatalogItemDetail(sourceItemId);
    if (!sourceItem || sourceItem.type !== 'registry:project') {
      return { status: 400, body: { error: `Unknown or non-cloneable project item "${sourceItemId}"` } };
    }
  }
  const starterTemplate = normalizeStarterTemplateId(
    body.starter_template ?? body.starterTemplate,
  );

  // Managed repo name = a readable slug from the display name + the project's
  // UUID, so managed repos under the shared org NEVER collide (two projects can
  // share a name). We generate the project id up front to bake it into the repo
  // name and reuse it as the project row id.
  const projectId = randomUUID();
  const baseSlug = (
    name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') ||
    'kortix-project'
  ).slice(0, 40);
  const repoSlug = `${baseSlug}-${projectId}`;
  const defaultBranch = normalizeString(body.default_branch ?? body.defaultBranch) ?? 'main';

  // IDEMPOTENCY — MUST STAY ABOVE `backend.createRepo`. Provision mints a
  // brand-new managed repo per call, so a repeat (a reload, a second tab, a
  // retry after a lost response) used to create a genuine duplicate project
  // with its own upstream repo. A caller that sends the same `idempotency_key`
  // for every attempt at one logical create gets the project the first attempt
  // made. Below `createRepo` this check would be worthless: the repo would
  // already exist upstream and deduping afterwards leaves it orphaned.
  //
  // It also runs before the quota check on purpose — a retry must not be
  // refused by the very project it is asking us to return.
  //
  // Unkeyed provision is unchanged: no key means no query, and creating a
  // second project with the same NAME still works. The quota check stays a
  // straight count — there is still no repoUrl to treat as an idempotent
  // re-link.
  //
  // NON-GOAL, stated so callers can rely on it: the key is NOT a fingerprint of
  // the request. It identifies the ATTEMPT, not the payload. The same key with
  // a different `name`, `starter_template`, or `source_item_id` returns the
  // FIRST project, silently ignoring the new payload. Clients must therefore
  // mint a fresh key per distinct create, and reuse one only across retries of
  // the same create.
  const alreadyProvisioned = await findIdempotentProvision(
    lookupProvisionByIdempotencyKey,
    scope.accountId,
    idempotencyKey,
  );
  const replay = classifyProvisionReplay(alreadyProvisioned, Date.now());
  if (replay.kind === 'in_flight') {
    // The first call is between its INSERT and its seed rollback, so its row
    // may still be deleted. Handing back its project_id here would be a 201
    // carrying an id that stops existing seconds later — worse than the loud
    // 502 the caller would have got without a key. Tell them to retry instead.
    setContextField('projectId', replay.project.projectId);
    return {
      status: 409,
      body: { error: 'Another provision with this idempotency_key is in flight', code: 'provision_in_flight' },
    };
  }
  if (replay.kind === 'replay') {
    setContextField('projectId', replay.project.projectId);
    return {
      status: 201,
      body: provisionReplayResponse(
        replay.project,
        await provisionReplayAccess(replay.project.projectId, scope.userId),
      ),
    };
  }

  const provisionQuota = await enforceProjectQuota(c, scope.accountId);
  if (provisionQuota) {
    // `enforceProjectQuota` hands back a raw Hono `Response` — `.status` is
    // a plain `number` at the type level even though its only failure branch
    // is a literal `403` (see `lib/access.ts`). This is the one place a
    // `number` from an external `Response` crosses into
    // `ProvisionResultStatus`; narrowed here instead of widening the field
    // for every other, fully-literal return in this function.
    return { status: provisionQuota.status as ProvisionResultStatus, body: await provisionQuota.json() };
  }

  emit('creating_repository');
  let provisioned: Awaited<ReturnType<typeof backend.createRepo>>;
  try {
    provisioned = await backend.createRepo({
      accountId: scope.accountId,
      projectId,
      slug: repoSlug,
      defaultBranch,
      isPrivate: true,
    });
  } catch (error) {
    return { status: 502, body: { error: (error as Error).message || 'Failed to provision managed repo' } };
  }

  const authMethod = provider === 'github' ? 'github_app' : 'managed';
  const now = new Date();

  // A PROJECT ALWAYS HAS A MANIFEST. Seeding is the DEFAULT, not an opt-in.
  //
  // `seed_starter` chooses WHO supplies the scaffold — the server here, or a
  // client that is about to push its own `kortix init` output — never WHETHER
  // the project gets one. It used to default to false, so a caller who said
  // nothing (a bare `POST /v1/projects/provision`, an agent, any integration)
  // got a repo with no kortix.yaml, no agents and no skills, recorded as
  // `caller_opted_out` so the self-heal skipped it permanently. See
  // ./managed-repo-seed.ts for the full rule.
  //
  // The one opt-out is an EXPLICIT `seed_starter: false` (`kortix ship`, which
  // pushes its own history with a plain non-force push that a seeded repo would
  // reject). Even that records `expected: true` with `client_owns_first_commit`,
  // so a client that never pushes is repaired on next access by
  // `shouldSelfHealManagedRepoSeed` instead of being left permanently blank —
  // and the repair re-checks `remoteBranchExists`, so it is a no-op once the
  // client HAS pushed.
  //
  // Resolved BEFORE the insert so the row records the INTENT: a crash between
  // the insert and a verified seed leaves `{ expected: true, seeded: false }`,
  // which the same repair path fixes.
  const clientOwnsFirstCommit = body.seed_starter === false || body.seedStarter === false;
  const seedStarter = !clientOwnsFirstCommit || !!sourceItemId;
  const marketplaceItems = normalizeMarketplaceItems(body.marketplace_items ?? body.marketplaceItems);
  const initialSeedState = buildManagedRepoSeedState(
    seedStarter
      ? { seeded: false, expected: true, reason: 'pending', at: now.toISOString(), template: sourceItemId ?? starterTemplate }
      : { seeded: false, expected: true, reason: 'client_owns_first_commit', at: now.toISOString(), template: starterTemplate },
  );

  const insertProjectRow = () => db
    .insert(projects)
    .values({
      projectId,
      accountId: scope.accountId,
      name,
      // Recorded so a LATER retry short-circuits above, and so the partial
      // unique index makes "one key, one project" true even when two calls
      // race past the pre-check. Null when the caller sent no key.
      idempotencyKey,
      repoUrl: provisioned.upstreamUrl,
      defaultBranch: provisioned.defaultBranch,
      // The starter this route seeds (buildProjectSeedFiles, below) ships
      // kortix.yaml (kortix_version 2) — record that as the canonical path so
      // a project created here is never labeled with a stale v1 filename. A
      // CLI `kortix ship` that pushes its own files instead of seeding still
      // scaffolded via `kortix init` (same @kortix/starter, same kortix.yaml),
      // so this holds for both the web and CLI creation paths.
      manifestPath: 'kortix.yaml',
      status: 'active',
      metadata: {
        git: {
          url: provisioned.upstreamUrl,
          upstream_url: provisioned.upstreamUrl,
          default_branch: provisioned.defaultBranch,
          provider,
          managed: true,
          auth: {
            method: authMethod,
            ref: provisioned.credentialRef,
            installation_id: provisioned.installationId,
          },
          repo_id: provisioned.externalRepoId,
          owner: provisioned.repoOwner,
          name: provisioned.repoName,
          // Scaffold-seed intent + outcome. Without this, an empty managed repo
          // is indistinguishable from a seeded one and nothing can repair it —
          // the defect behind "brand-new project has no files, no agents, no
          // skills, and session start 500s on refs/heads/main".
          seed: initialSeedState,
        },
        // MANDATORY DECLARED AGENTS (docs/specs/2026-07-05-agent-first-config-
        // unification.md §2.1/§3 Phase 2): every project created through this
        // route is "new" in the spec's sense — subject to declared-agent
        // enforcement from birth, regardless of the platform-wide
        // KORTIX_REQUIRE_DECLARED_AGENTS flag (see projectRequiresDeclaredAgents /
        // createProjectSession). Pre-existing projects (this flag absent/false)
        // keep the v1 adopt-to-govern behavior untouched.
        require_declared_agents: true,
        ...(iconGlyph ? { icon_glyph: iconGlyph } : icon ? { icon } : {}),
      },
      updatedAt: now,
    })
    .returning();

  let row: Awaited<ReturnType<typeof insertProjectRow>>[number];
  emit('registering');
  try {
    [row] = await insertProjectRow();
  } catch (error) {
    // Two provisions carrying one key raced past the pre-check above and this
    // one lost the partial unique index. The winner's project exists; this
    // request's upstream repo does not belong to anything and must not be left
    // behind — that orphan is the exact outcome the key exists to prevent.
    if (!isProvisionIdempotencyConflict(error)) throw error;
    const winner = await findIdempotentProvision(
      lookupProvisionByIdempotencyKey,
      scope.accountId,
      idempotencyKey,
    );
    const mintedRepo = provisioned.repoName ?? provisioned.upstreamUrl;
    const orphanContext =
      `account=${scope.accountId} key=${idempotencyKey} ` +
      `winner=${winner?.projectId ?? 'unresolved'} repo=${mintedRepo} ` +
      `owner=${provisioned.repoOwner ?? 'unknown'} repo_id=${provisioned.externalRepoId ?? 'unknown'}`;
    console.warn(
      `[projects] provision lost an idempotency-key race ${orphanContext} — deleting the repo ` +
        `this request minted`,
    );
    // The DELETE MUST LEAVE A RECORD EITHER WAY. This is the one path whose
    // entire purpose is preventing an orphaned managed repo, so a failure here
    // that logs nothing turns "no orphan is left behind" into a claim nobody
    // can check. The warn above states intent; these state outcome. Same shape
    // as the seed rollback below (console.error, repo identity, stage).
    if (!provisioned.repoOwner || !provisioned.repoName) {
      // git-backends/github.ts `deleteRepo` returns silently without an owner
      // and name — the repo would survive with no trace of why.
      console.error(
        `[projects] ORPHANED MANAGED REPO — provision cannot delete the repo it minted, the ` +
          `backend ref has no owner/name ${orphanContext} stage=idempotency_race`,
      );
    } else {
      try {
        await backend.deleteRepo({
          provider,
          upstreamUrl: provisioned.upstreamUrl,
          externalRepoId: provisioned.externalRepoId,
          repoOwner: provisioned.repoOwner,
          repoName: provisioned.repoName,
          installationId: provisioned.installationId,
          credentialRef: provisioned.credentialRef,
          defaultBranch: provisioned.defaultBranch,
          managed: true,
          metadata: {},
        } satisfies GitConnectionRef);
      } catch (deleteError) {
        console.error(
          `[projects] ORPHANED MANAGED REPO — provision failed to delete the repo it minted ` +
            `${orphanContext} stage=idempotency_race:`,
          deleteError instanceof Error ? deleteError.message : deleteError,
        );
      }
    }
    // ONE RULE, BOTH CALL SITES — the winner goes through the SAME classifier
    // the pre-check uses. This path is MORE exposed to the in-flight problem,
    // not less: we re-read the winner milliseconds after its own INSERT, while
    // its seed push is still running, so a pending seed here is the normal case
    // rather than a narrow overlap. Replaying it would hand back a project_id
    // the winner's own rollback may delete.
    //
    // `classifyProvisionReplay(null, …)` is `create`, so this single branch
    // also covers a winner we cannot re-read — which is a 409 for the same
    // reason, never a 500 with an orphan: the constraint proved a project with
    // this key exists, so retrying is right.
    const winnerReplay = classifyProvisionReplay(winner, Date.now());
    if (winnerReplay.kind !== 'replay') {
      return {
        status: 409,
        body: { error: 'Another provision with this idempotency_key is in flight', code: 'provision_in_flight' },
      };
    }
    setContextField('projectId', winnerReplay.project.projectId);
    return {
      status: 201,
      body: provisionReplayResponse(
        winnerReplay.project,
        await provisionReplayAccess(winnerReplay.project.projectId, scope.userId),
      ),
    };
  }
  setContextField('projectId', row.projectId);

  await grantProjectRole({
    accountId: scope.accountId,
    projectId: row.projectId,
    userId: scope.userId,
    role: 'manager',
    grantedBy: scope.userId,
  });
  await upsertProjectGitConnection({
    accountId: scope.accountId,
    projectId: row.projectId,
    provider,
    repoUrl: provisioned.upstreamUrl,
    upstreamUrl: provisioned.upstreamUrl,
    managed: true,
    repoOwner: provisioned.repoOwner,
    repoName: provisioned.repoName,
    externalRepoId: provisioned.externalRepoId,
    defaultBranch: provisioned.defaultBranch,
    authMethod,
    installationId: provisioned.installationId,
    credentialRef: provisioned.credentialRef,
    visibility: 'private',
    status: 'connected',
    // `seeded: false` used to be hard-coded here and never updated, so the
    // connection row claimed every project was unseeded — including seeded
    // ones. Record the seed INTENT instead; the authoritative, updated state
    // lives on `projects.metadata.git.seed` (see managed-repo-seed.ts).
    metadata: { seed_expected: initialSeedState.expected },
  });
  const connRef = buildConnectionRef(
    row,
    getProjectGitRemote(row, await getProjectGitConnection(row.projectId)),
  );

  // Resolve a push credential for seeding / the CLI's first push. The managed
  // GitHub backend mints an installation token.
  let internalPushToken = provisioned.initialToken;
  let exportablePushToken = provisioned.initialToken;
  if (!internalPushToken) {
    const resolved = await resolveProjectGitAuth(row);
    internalPushToken = resolved.auth?.token ?? null;
    exportablePushToken = resolved.authSource === 'pat'
      ? null
      : resolved.auth?.token ?? null;
  }
  const writeUpstream = internalPushToken
    ? backend.buildUpstream(connRef, internalPushToken, 'write')
    : null;
  const exportableCredential = exportablePushToken
    ? parseBasicAuthHeader(
        backend.buildUpstream(connRef, exportablePushToken, 'write').headers.Authorization,
      )
    : null;

  // If seeding fails we roll back the orphan repo + project so we never leave a
  // half-created project behind — and, since #5871, "fails" includes "the
  // backend accepted the push but the default branch is not there". A project
  // whose repo has no default branch is structurally unusable (no files, no
  // agents, no skills, manifest detection falls back to v1, session start dies
  // on `couldn't find remote ref refs/heads/main`), so it must never be
  // reported as `status: active`.
  let seeded = false;
  emit('seeding');
  if (seedStarter) {
    try {
      if (!internalPushToken) throw new Error('no push credential resolved for seeding');
      const seed = sourceItemId
        ? await buildProjectSeedFilesFromItem({
            id: sourceItemId,
            projectName: name,
            repoFullName: repoSlug,
            extraMarketplaceItems: marketplaceItems,
            now: now.toISOString(),
          })
        : await buildProjectSeedFiles({
            projectName: name,
            repoFullName: repoSlug,
            template: starterTemplate,
            marketplaceItems,
            now: now.toISOString(),
          });
      // Seed a deterministic scaffold root followed by the project's small
      // customization commit. Fresh-session boot can import that exact second
      // commit from the API mirror as a bounded Git bundle, on top of the
      // image-baked root, without an in-sandbox network fetch.
      await pushVerifiedSeed({
        projectId: row.projectId,
        branch: provisioned.defaultBranch,
        push: () =>
          pushSeedFiles({
            backend,
            connRef,
            token: internalPushToken as string,
            branch: provisioned.defaultBranch,
            files: seed.files,
            baseFiles: seed.baseFiles,
          }),
        remoteHasBranch: () =>
          remoteBranchExists(
            {
              projectId: row.projectId,
              repoUrl: writeUpstream?.url ?? connRef.upstreamUrl,
              defaultBranch: provisioned.defaultBranch,
              manifestPath: row.manifestPath,
              gitAuthToken: internalPushToken,
              gitAuthHeaders: writeUpstream?.headers ?? {},
            },
            provisioned.defaultBranch,
          ),
      });
      seeded = true;

      // Mirror the seeded manifest's declared default agent into
      // project.metadata (see defaultAgentFromSeedFiles in ../seed-files.ts)
      // so session creation resolves it from birth instead of falling back
      // to the non-binding 'default' sentinel — see
      // llm-gateway/resolution/default-model.ts's cachedSessionAgent for the
      // defense-in-depth fallback that also covers pre-existing/CLI-created
      // projects where this mirror is still stale.
      const seededDefaultAgent = defaultAgentFromSeedFiles(seed.files, row.manifestPath);
      const verifiedSeedState = buildManagedRepoSeedState({
        seeded: true,
        expected: true,
        reason: 'seeded',
        at: new Date().toISOString(),
        template: sourceItemId ?? starterTemplate,
      });
      row.metadata = {
        ...((row.metadata as Record<string, unknown> | null) ?? {}),
        ...(seededDefaultAgent ? { default_agent: seededDefaultAgent } : {}),
        git: {
          ...(((row.metadata as { git?: Record<string, unknown> } | null)?.git) ?? {}),
          seed: verifiedSeedState,
        },
      };
      // Persist ONLY the keys this step owns via a SQL-side atomic merge (never
      // the whole object) so this creation-seed write can't revert a pin the
      // prebuild kick may have activated concurrently. `row.metadata` above is
      // the in-memory copy the creation response serializes.
      await db
        .update(projects)
        .set({
          metadata: metadataMerge({
            ...(seededDefaultAgent ? { default_agent: seededDefaultAgent } : {}),
            git: { seed: verifiedSeedState },
          }),
          updatedAt: new Date(),
        })
        .where(eq(projects.projectId, row.projectId))
        .catch(() => {}); // best-effort — a mirror-write hiccup must not fail project creation

      // Same switch as the create-time hint (#6973): a seeded project's FIRST
      // session must already find its base tip + scaffold delta cached.
      if (config.KORTIX_FAST_GIT_BOOT_ENABLED && writeUpstream) {
        const hintTask = resolveFastBootGitHintWithCache(
          {
            projectId: row.projectId,
            repoUrl: writeUpstream.url,
            defaultBranch: provisioned.defaultBranch,
            manifestPath: row.manifestPath,
            gitAuthToken: null,
            gitAuthHeaders: writeUpstream.headers,
          },
          provisioned.defaultBranch,
          null,
        )
          .then((hint) =>
            buildCachedFastBootGitHint(provisioned.defaultBranch, hint),
          )
          .catch((error) => {
            console.warn('[projects] fast-boot seed hint unavailable', {
              projectId: row.projectId,
              error: error instanceof Error ? error.message : String(error),
            });
            return null;
          });
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const cachedHint = await Promise.race([
          hintTask,
          new Promise<null>((resolve) => {
            timeout = setTimeout(() => resolve(null), FAST_BOOT_SEED_HINT_TIMEOUT_MS);
          }),
        ]).finally(() => {
          if (timeout) clearTimeout(timeout);
        });
        if (cachedHint) {
          const currentMetadata = (row.metadata as Record<string, unknown> | null) ?? {};
          const currentGit =
            currentMetadata.git && typeof currentMetadata.git === 'object'
              ? (currentMetadata.git as Record<string, unknown>)
              : {};
          row.metadata = {
            ...currentMetadata,
            git: { ...currentGit, fast_boot: cachedHint },
          };
        }
      }
    } catch (error) {
      const stage = error instanceof ManagedRepoSeedError ? error.stage : 'push';
      console.error(
        `[projects] provision rolled back project=${row.projectId} account=${scope.accountId} ` +
          `repo=${connRef.repoName ?? connRef.upstreamUrl} stage=${stage}:`,
        error instanceof Error ? error.message : error,
      );
      try { await backend.deleteRepo(connRef); } catch { /* best effort */ }
      await db.delete(projects).where(eq(projects.projectId, row.projectId)).catch(() => {});
      return {
        status: 502,
        body: {
          error: (error as Error).message || 'Failed to seed project repo',
          code: stage === 'verify' ? 'seed_verification_failed' : 'seed_push_failed',
        },
      };
    }
  } else {
    // Legal, but never silent: the caller owns this repo's first commit. Log it
    // so an empty managed repo in production is always attributable.
    console.warn(
      `[projects] provisioned managed repo WITHOUT a scaffold seed project=${row.projectId} account=${scope.accountId} repo=${connRef.repoName ?? connRef.upstreamUrl} — the caller must push the first commit (kortix ship); the project has no default branch yet`,
    );
  }

  if (seeded) {
    kickProjectTemplatePrebuilds(
      {
        projectId: row.projectId,
        repoUrl: writeUpstream?.url ?? row.repoUrl,
        defaultBranch: row.defaultBranch,
        manifestPath: row.manifestPath,
        gitAuthToken: internalPushToken,
        gitAuthHeaders: writeUpstream?.headers ?? {},
      },
      { accountId: scope.accountId, source: 'project-create' },
    );
  }

  return {
    status: 201,
    body: {
      ...serializeProject(row, { projectRole: 'manager', effectiveRole: 'manager' }),
      push_token: exportablePushToken,
      git_username: exportableCredential?.username ?? null,
      repo_id: provisioned.externalRepoId,
      seeded,
    },
  };
}
