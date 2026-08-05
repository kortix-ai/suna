import { db } from '../../shared/db';
import { projects } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import type { ProjectRole } from '../access';
import { readManagedRepoSeedState } from '../managed-repo-seed';
import { normalizeString, serializeProject } from './serializers';
import type { ProjectRow } from './serializers';

/**
 * Request-level dedupe for POST /v1/projects/provision.
 *
 * THE DEFECT. That route mints a brand-new managed repo on every call, and its
 * only guard was `enforceProjectQuota` — a straight count. On any account whose
 * quota permits two or more projects, a retry after a lost response (a reload,
 * a second onboarding tab, an aborted request, a client-side retry) created a
 * real duplicate project WITH ITS OWN upstream GitHub repo. That is how users
 * ended up with several "My First Project" rows.
 *
 * THE FIX. The caller sends the same `idempotency_key` for every attempt at one
 * logical create. The route looks it up BEFORE `backend.createRepo` and returns
 * the project the first attempt made. Two properties matter and neither is
 * optional:
 *
 *   1. The check runs before anything exists upstream. After `createRepo` a
 *      GitHub repo is already there, and deduping later leaves it orphaned.
 *   2. The key lives on the project row, not in this process. The API runs
 *      several replicas; an in-memory map deduplicates neither a restart nor a
 *      retry that lands on another instance.
 *
 * The pre-check is a read, so two simultaneous calls can both miss it. The
 * partial unique index `idx_projects_account_idempotency_key` is what actually
 * makes "exactly one" true; `isProvisionIdempotencyConflict` lets the route
 * recognise the loser of that race, drop the repo it just minted, and return
 * the winner's project.
 */

/**
 * Long enough for a UUID with a namespace prefix, short enough that the column
 * cannot be used as free storage. Callers should send one opaque token per
 * create attempt.
 */
export const PROVISION_IDEMPOTENCY_KEY_MAX_LENGTH = 200;

/**
 * The partial unique index on `(account_id, idempotency_key)`. Named here
 * because `isProvisionIdempotencyConflict` matches Postgres's `constraint_name`
 * against it — a unique violation on any OTHER constraint must not be mistaken
 * for ours, since the caller responds by deleting a freshly minted repo.
 */
export const PROVISION_IDEMPOTENCY_UNIQUE_INDEX = 'idx_projects_account_idempotency_key';

/**
 * Opaque-token alphabet: UUIDs, prefixed UUIDs, and dotted/colon-namespaced
 * ids. Deliberately excludes whitespace — a key that differs from another only
 * by an invisible character is a dedupe that silently does not dedupe.
 */
const KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;

export type ProvisionIdempotencyKeyResult =
  | { ok: true; key: string | null }
  | { ok: false; error: string };

/**
 * Read `idempotency_key` (or `idempotencyKey`) off the provision body.
 *
 * `{ ok: true, key: null }` means the caller sent no key and provision behaves
 * exactly as it always did. Absent, empty, and whitespace-only all collapse to
 * that — the alternative reading, an empty-string key, would make every
 * keyless create share one key and hand the second caller the first caller's
 * project.
 *
 * A present-but-unusable key is an error rather than a silent downgrade to
 * "no key": a caller that believes it is protected against duplicates must not
 * be quietly unprotected.
 */
export function readProvisionIdempotencyKey(
  body: Record<string, unknown>,
): ProvisionIdempotencyKeyResult {
  // Snake_case first, then camelCase — and a BLANK field falls through to the
  // next candidate rather than ending the search. `'' ?? x` is `''`, so a
  // nullish coalesce here would let `{idempotency_key: '', idempotencyKey: 'k'}`
  // silently drop the usable key, which is precisely the silent downgrade this
  // function promises not to do. A non-string still stops everything: the
  // caller sent something, and we must not pretend they did not.
  for (const raw of [body.idempotency_key, body.idempotencyKey]) {
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string') {
      return { ok: false, error: 'idempotency_key must be a string' };
    }

    const key = normalizeString(raw);
    if (!key) continue;

    if (key.length > PROVISION_IDEMPOTENCY_KEY_MAX_LENGTH) {
      return {
        ok: false,
        error: `idempotency_key must be ${PROVISION_IDEMPOTENCY_KEY_MAX_LENGTH} characters or fewer`,
      };
    }
    if (!KEY_PATTERN.test(key)) {
      return {
        ok: false,
        error: 'idempotency_key must contain only letters, numbers, dots, colons, hyphens or underscores',
      };
    }
    return { ok: true, key };
  }
  return { ok: true, key: null };
}

/**
 * The single database seam this module has, so the flow above is testable
 * without a database and without `mock.module` (which is process-wide in this
 * app and leaks into sibling suites).
 */
export type ProvisionIdempotencyLookup = (
  accountId: string,
  idempotencyKey: string,
) => Promise<ProjectRow | null>;

/**
 * Production lookup. Matches the partial unique index EXACTLY — same two
 * columns, no `status` filter. Filtering here to active projects would let the
 * pre-check miss a row the index still refuses to duplicate, turning an
 * archived project into an unrecoverable 500 on every retry of its key.
 */
export const lookupProvisionByIdempotencyKey: ProvisionIdempotencyLookup = async (
  accountId,
  idempotencyKey,
) => {
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.accountId, accountId), eq(projects.idempotencyKey, idempotencyKey)))
    .limit(1);
  return row ?? null;
};

/**
 * The short-circuit decision. Returns the already-provisioned project for this
 * (account, key) pair, or `null` to mean "go ahead and provision".
 *
 * With no key there is no query: an unkeyed provision must cost exactly what it
 * cost before, and creating a second project with the same NAME deliberately
 * must keep working.
 */
export async function findIdempotentProvision(
  lookup: ProvisionIdempotencyLookup,
  accountId: string,
  idempotencyKey: string | null,
): Promise<ProjectRow | null> {
  if (!idempotencyKey) return null;
  return await lookup(accountId, idempotencyKey);
}

/**
 * How long after a project row appears its provision is still assumed to be
 * RUNNING, and therefore still able to roll itself back.
 *
 * WHY A WINDOW EXISTS AT ALL. The create path inserts the row with
 * `metadata.git.seed = {expected:true, seeded:false}` and only THEN pushes the
 * scaffold. If that push fails it deletes the upstream repo AND
 * `db.delete(projects)` the row it just inserted (`routes/r1.ts`, the seed
 * rollback). A replay served during that gap hands the caller a `project_id`
 * that is about to stop existing — and its next retry, finding nothing, creates
 * a second project. That is the exact double-submit case the key exists for, so
 * a fresh pending row must be a retryable `409`, never a confident `201`.
 *
 * WHY IT MUST EXPIRE. A pod killed mid-seed leaves `{expected:true,
 * seeded:false}` on the row permanently. `shouldSelfHealManagedRepoSeed`
 * (`../managed-repo-seed.ts`) is what repairs that on next access, so an
 * unbounded in-flight check would make such a project un-replayable forever —
 * trading a rare wrong `201` for a guaranteed permanent `409`.
 *
 * WHY 120s. It is the longest window any first-party client waits on this exact
 * route: `@kortix/sdk`'s `provisionProject` sends `timeout: 120_000`
 * (`provisionProjectWithToken` uses 90s, and Bun's `idleTimeout: 45` closes the
 * socket even earlier — `/provision` is exempt from the 25s request deadline
 * but not from that). Past 120s no caller is still attached to the original
 * request, so a row still pending is far more likely a dead provision than live
 * work, and the self-heal path is the right owner. Residual, stated plainly: a
 * provision whose seed is still running at 121s and fails at 122s can still
 * strand one replayed id. Narrowing that further would cost recovery time on
 * the far more common crashed-seed case.
 */
export const PROVISION_IN_FLIGHT_WINDOW_MS = 120_000;

export type ProvisionReplayDecision =
  | { kind: 'create' }
  | { kind: 'replay'; project: ProjectRow }
  | { kind: 'in_flight'; project: ProjectRow };

/**
 * Decide what a found (or not found) project means for this provision call.
 *
 * `in_flight` is gated on `{expected:true, seeded:false}` because that state is
 * exactly the rollback-capable window: a caller that opted out of seeding
 * (`expected:false`, i.e. `kortix ship`) never enters the seed try/catch, so
 * nothing can delete its row, and a verified seed (`seeded:true`) is already
 * past the danger. A legacy row with no readable seed state is treated as
 * settled — those projects predate this metadata and nothing is going to roll
 * them back now.
 *
 * `now` and `windowMs` are parameters, not ambient reads, so the bound itself
 * is testable.
 */
export function classifyProvisionReplay(
  project: ProjectRow | null,
  now: number,
  windowMs: number = PROVISION_IN_FLIGHT_WINDOW_MS,
): ProvisionReplayDecision {
  if (!project) return { kind: 'create' };

  const seed = readManagedRepoSeedState(project.metadata);
  const seedPending = seed?.expected === true && seed.seeded === false;
  const age = now - project.createdAt.getTime();
  if (seedPending && age < windowMs) return { kind: 'in_flight', project };

  return { kind: 'replay', project };
}

/**
 * True only for a unique violation on THIS route's dedupe index — the loser of
 * a race between two simultaneous provisions carrying one key.
 *
 * Narrow on purpose. The caller's response is to delete the managed repo it
 * just minted, so a unique violation on some other constraint must never match:
 * that would destroy a repo this dedupe has no claim over.
 *
 * Drizzle wraps the postgres-js error as `cause`; the wrapper's own message is
 * the formatted "Failed query: …" string and carries no SQLSTATE. Some adapters
 * surface the code on the top-level error instead, so both are checked (same
 * shape as `accounts/iam/helpers.ts`'s `isUniqueViolation`).
 */
export function isProvisionIdempotencyConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidates = [
    (error as { cause?: { code?: string; constraint_name?: string } }).cause,
    error as { code?: string; constraint_name?: string },
  ];
  return candidates.some(
    (candidate) =>
      candidate?.code === '23505' &&
      candidate?.constraint_name === PROVISION_IDEMPOTENCY_UNIQUE_INDEX,
  );
}

/**
 * The two provision-response fields that are not on the project row itself.
 * On the create path they come from the live `createRepo` result; on the
 * deduped path they have to be recovered from what that first call persisted,
 * so a retry's body matches the response the caller lost.
 *
 * Every read is defensive: `metadata` is free-form jsonb, and a project created
 * before a given key existed must degrade to a null rather than throw on a
 * retry.
 */
export function describeProvisionedRepo(row: {
  metadata?: Record<string, unknown> | null;
}): { repoId: string | null; seeded: boolean } {
  const git = asRecord(row.metadata)?.git;
  const gitRecord = asRecord(git);
  const rawRepoId = gitRecord?.repo_id;
  const repoId =
    typeof rawRepoId === 'string'
      ? rawRepoId
      : typeof rawRepoId === 'number'
        ? String(rawRepoId)
        : null;
  // Same reader the rest of the codebase uses, so "seeded" means here exactly
  // what it means to `shouldSelfHealManagedRepoSeed`.
  const seeded = readManagedRepoSeedState(row.metadata)?.seeded === true;
  return { repoId, seeded };
}

/**
 * The 201 body a deduped provision returns: the same shape the original create
 * returned, rebuilt from what that create persisted.
 *
 * `push_token` / `git_username` are null and cannot be otherwise. The create
 * path hands back a one-shot push credential minted alongside the repo; a
 * later retry is a different request and must not silently mint a second
 * credential as a side effect of a read. A caller that needs to push after a
 * retry asks for one explicitly at `POST /v1/projects/:projectId/git-token`,
 * which exists for exactly that.
 *
 * `access` is supplied by the caller rather than assumed. The create path can
 * hard-code `manager` because it just called `grantProjectRole`; a replay
 * cannot. `grantProjectRole` runs ONLY on the create path, so a second account
 * admin replaying someone else's key holds no `project_members` row at all, and
 * reporting `project_role: 'manager'` would claim an explicit grant that does
 * not exist. The route resolves the real grant and passes it here.
 */
export function provisionReplayResponse(
  row: ProjectRow,
  access: { projectRole: ProjectRole | null; effectiveRole: ProjectRole },
) {
  const { repoId, seeded } = describeProvisionedRepo(row);
  return {
    ...serializeProject(row, access),
    push_token: null,
    git_username: null,
    repo_id: repoId,
    seeded,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
