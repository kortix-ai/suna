/**
 * A project whose FIRST preparation fails must come back on its own.
 *
 * `prepareRefTip` cannot help here: with no repository id it returns before it
 * can schedule anything, and the ref table — which every other retry path is
 * keyed on — has no row to schedule against. Without these scans the project is
 * invisible until someone sends another webhook or runs a backfill by hand.
 *
 * Two failure shapes are covered, both against the real database:
 *   1. the identity lookup fails, repeatedly, behind other failing projects;
 *   2. the identity is persisted but the first ref row is never written.
 *
 * The GitHub API is served over real HTTP from a loopback stub: `getRepo` runs
 * unmodified, only the socket is local. Nothing reaches github.com.
 *
 * Run (from apps/api):
 *   dotenvx run -f .env.local -f .env --quiet -- bash -c 'export \
 *     DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:13922/postgres \
 *     KORTIX_URL=http://127.0.0.1:13608; bun test --isolate \
 *     src/__tests__/integration-repo-snapshot-discovery.test.ts'
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';

process.env.KORTIX_REPO_SNAPSHOT_ENDPOINT ??= 'http://127.0.0.1:19000';
process.env.KORTIX_REPO_SNAPSHOT_BUCKET ??= 'kortix-repo-snapshots';
process.env.KORTIX_REPO_SNAPSHOT_ACCESS_KEY_ID ??= 'kortixsnapshots';
process.env.KORTIX_REPO_SNAPSHOT_SECRET_ACCESS_KEY ??= 'kortixsnapshots123';
process.env.KORTIX_REPO_SNAPSHOT_REGION ??= 'us-east-1';
process.env.KORTIX_REPO_SNAPSHOT_MODE = 'shadow';

const { db } = await import('../shared/db');
const { projects } = await import('@kortix/db');
const { eq } = await import('drizzle-orm');
const { prepareRefTip } = await import('../repo-snapshots/prepare');
const { readRepoRef } = await import('../repo-snapshots/store');
const {
  discoverUnregisteredProjects,
  reconcileRef,
  resetRepoSnapshotDiscoveryBackoff,
  runRepoSnapshotTick,
  scheduleMissingDefaultRefs,
} = await import('../repo-snapshots/worker');
const { findRepoSnapshot } = await import('../repo-snapshots/store');
const { normalizeRepoSnapshotIdentity } = await import('../repo-snapshots/format');
const { writeSharedProjectSecret } = await import('../projects/secrets');
const { readRepoSnapshotRepository } = await import('../repo-snapshots/identity');
const { getProjectGitRemote, upsertProjectGitCredential } = await import('../projects/lib/git');
const { gitMetadataSubtree, repositoryIdFields } = await import('../repo-snapshots/identity');
const { metadataMergeSubtree } = await import('../projects/lib/metadata-merge');

const ALLOW_SKIP = process.env.KORTIX_REPO_SNAPSHOT_E2E === 'skip';
let ready = false;
let reason = '';
let accountId = '';
const created: string[] = [];
/** Three broken projects ahead of the good one: more than one page of failures. */
const BROKEN = ['discovery-broken-a', 'discovery-broken-b', 'discovery-broken-c'];
const ids = new Map<string, string>();
const goodRepoId = String(940000000 + Math.floor(Math.random() * 9000000));
/** The id the stub hands back for the legacy fixtures. */
const legacyAppRepoId = String(930000000 + Math.floor(Math.random() * 9000000));
/** A project that is still unregistered when its first push arrives. */
const pushRepoId = String(920000000 + Math.floor(Math.random() * 9000000));
/** A project whose first push arrives while GitHub is failing. */
const parkedRepoId = String(925000000 + Math.floor(Math.random() * 9000000));
/** A project whose push exceeds the parking bound. */
const overflowRepoId = String(935000000 + Math.floor(Math.random() * 9000000));
/** Registered, but its ref row never got written. Nothing else can find it. */
const orphanRepoId = String(950000000 + Math.floor(Math.random() * 9000000));
/** A legacy project that already carries its id under `github.repo_id`. */
const legacyDoneRepoId = String(960000000 + Math.floor(Math.random() * 9000000));

let githubHealthy = false;
/** The commit every fixture ref resolves to. */
const fixtureSha = 'c'.repeat(39) + '7';
/** Flipped by the parked-push test to fail the identity lookup on demand. */
let parkedProjectFails = false;
/** How many branches the stub says the repository has. */
let overflowBranchCount = 0;
const lookups: string[] = [];
/** Any GitHub path outside the fixture namespace. Must stay empty. */
const foreignCalls: string[] = [];
let server: ReturnType<typeof Bun.serve> | null = null;
const realFetch = globalThis.fetch;
/**
 * Every repository id and project id this test owns.
 *
 * Cleanup deletes exactly these and nothing else. A before/after diff of the
 * whole table would delete rows a concurrent writer — the real worker, another
 * suite — created while this one ran.
 */
const ownedRepositoryIds = new Set<string>([
  goodRepoId,
  legacyAppRepoId,
  pushRepoId,
  parkedRepoId,
  overflowRepoId,
  orphanRepoId,
  legacyDoneRepoId,
]);

async function seedProject(name: string, extraGit: Record<string, unknown> = {}): Promise<string> {
  const id = crypto.randomUUID();
  await db.execute(sql`
    insert into kortix.projects (project_id, account_id, name, repo_url, default_branch, manifest_path, status, metadata)
    values (${id}, ${accountId}, ${name}, ${`https://github.com/kortix-ai/${name}.git`}, 'main', 'kortix.yaml',
            'active',
            ${JSON.stringify({
              git: {
                provider: 'github',
                owner: 'kortix-ai',
                name,
                upstream_url: `https://github.com/kortix-ai/${name}.git`,
                auth: { method: 'project_credential' },
                ...extraGit,
              },
            })}::jsonb)`);
  // A real credential, resolved through the real auth chain: every GitHub API
  // call in this codebase requires a token, so a fixture without one would
  // never reach `getRepo` and would prove nothing. The value is fake and lives
  // only in the isolated test database.
  await upsertProjectGitCredential({
    accountId,
    projectId: id,
    provider: 'github',
    token: `fixture-token-${id}`,
    createdBy: accountId,
  });
  created.push(id);
  ids.set(name, id);
  return id;
}

/**
 * The pre-`metadata.git` shape: `metadata.github` with `repo_id` and
 * `auth_source`. `getProjectGitRemote` reads it ONLY when `metadata.git` is
 * absent, so anything that creates a partial `git` subtree here silently
 * downgrades the project to provider `generic` with no auth.
 */
async function seedLegacyProject(
  name: string,
  github: Record<string, unknown>,
): Promise<string> {
  const id = crypto.randomUUID();
  await db.execute(sql`
    insert into kortix.projects (project_id, account_id, name, repo_url, default_branch, manifest_path, status, metadata)
    values (${id}, ${accountId}, ${name}, ${`https://github.com/kortix-ai/${name}.git`}, 'main', 'kortix.yaml',
            'active', ${JSON.stringify({ github })}::jsonb)`);
  created.push(id);
  ids.set(name, id);
  return id;
}

async function projectRow(id: string) {
  const [row] = await db.select().from(projects).where(eq(projects.projectId, id)).limit(1);
  return row ?? null;
}

async function repositoryIdOf(name: string): Promise<string | null> {
  const row = await projectRow(ids.get(name) as string);
  return readRepoSnapshotRepository(row as never).repository?.repositoryId ?? null;
}

beforeAll(async () => {
  try {
    await db.execute(sql`select 1 from kortix.repo_snapshot_refs limit 1`);
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
    return;
  }

  server = Bun.serve({
    port: 0,
    fetch(request) {
      // Decoded: the ref endpoint sends `heads%2Fmain` as one path segment.
      const path = decodeURIComponent(new URL(request.url).pathname);
      lookups.push(path);
      // Fixture coordinates ONLY. A call for anything else means the test has
      // reached a project it does not own, and must fail loudly rather than
      // answer for someone else's repository.
      if (!path.startsWith('/repos/kortix-ai/discovery-')) {
        foreignCalls.push(path);
        return new Response('{"message":"not a fixture repository"}', { status: 599 });
      }
      // Broken for the whole test: they must never block the projects behind them.
      if (!githubHealthy || /discovery-broken/.test(path) || parkedProjectFails) {
        return new Response('{"message":"Server Error"}', { status: 500 });
      }
      // The repository's authoritative branch list, paged like GitHub's.
      const branchList = path.match(/^\/repos\/kortix-ai\/([^/]+)\/branches$/);
      if (branchList) {
        const url = new URL(request.url);
        const perPage = Number(url.searchParams.get('per_page') ?? '100');
        const page = Number(url.searchParams.get('page') ?? '1');
        const names = Array.from({ length: overflowBranchCount }, (_, index) => `bulk-${index}`);
        const slice = names.slice((page - 1) * perPage, page * perPage);
        return new Response(JSON.stringify(slice.map((name) => ({ name }))), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const refMatch = path.match(/^\/repos\/kortix-ai\/([^/]+)\/git\/ref\/heads\/(.+)$/);
      if (refMatch) {
        // One branch that always fails, to prove one bad ref cannot take the
        // rest of a push with it.
        if (refMatch[2] === 'boom') return new Response('{"message":"Server Error"}', { status: 500 });
        return new Response(JSON.stringify({ object: { sha: fixtureSha, type: 'commit' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const slug = path.split('/')[3] ?? '';
      const id =
        slug === 'discovery-legacy-app'
          ? legacyAppRepoId
          : slug === 'discovery-push'
            ? pushRepoId
            : slug === 'discovery-parked'
              ? parkedRepoId
              : slug === 'discovery-overflow'
                ? overflowRepoId
                : goodRepoId;
      return new Response(JSON.stringify({ id: Number(id), full_name: `kortix-ai/${slug}` }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  globalThis.fetch = ((input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // Compare the PARSED origin, never a string prefix: `https://api.github.com.example`
    // starts with the same characters and is a different host entirely.
    const parsed = URL.parse?.(url) ?? (() => { try { return new URL(url); } catch { return null; } })();
    if (parsed?.origin === 'https://api.github.com') {
      return realFetch(base + parsed.pathname + parsed.search, init);
    }
    return realFetch(input, init);
  }) as typeof fetch;

  const accounts = (await db.execute(
    sql`select account_id from kortix.accounts limit 1`,
  )) as unknown as Array<{ account_id: string }>;
  accountId = accounts[0]?.account_id ?? crypto.randomUUID();
  if (!accounts[0]?.account_id) {
    await db.execute(
      sql`insert into kortix.accounts (account_id, name) values (${accountId}, ${'discovery-e2e'})`,
    );
  }
  for (const name of BROKEN) await seedProject(name);
  await seedProject('discovery-good');
  // Put the good project LAST in the scan order, behind three failing ones, by
  // dating its (fictional) previous attempt. Never-attempted rows sort first,
  // so without this the order among four equal keys would be arbitrary and the
  // "several pages of failures" case would only sometimes be exercised.
  await db.execute(sql`
    update kortix.projects
    set metadata = metadata || jsonb_build_object('git',
      (metadata -> 'git') || jsonb_build_object('snapshot_discovery_at', ${new Date(
        Date.now() - 60 * 60_000,
      ).toISOString()}::text))
    where project_id = ${ids.get('discovery-good') as string}`);
  // Registered already — it only lacks the ref row.
  await seedProject('discovery-orphan', { external_repo_id: orphanRepoId });
  // Legacy shapes: one BYO GitHub App, one PAT, neither with a repository id.
  await seedLegacyProject('discovery-legacy-app', { installation_id: '4242' });
  await seedLegacyProject('discovery-legacy-pat', { auth_source: 'pat' });
  // A legacy project that is ALREADY registered: it must not be selected at all.
  await seedLegacyProject('discovery-legacy-done', { auth_source: 'pat', repo_id: legacyDoneRepoId });
  // The legacy BYO-token shape: a project secret, not a `project_git_credentials`
  // row, which is what `resolveProjectGitAuth` falls back to for `auth_source: pat`.
  // Written through the real encryption path, then given the delivery policy the
  // git proxy requires — `secretPolicyAllowsConsumer` denies anything else.
  await writeSharedProjectSecret({
    projectId: ids.get('discovery-legacy-done') as string,
    name: 'KORTIX_GIT_AUTH_TOKEN',
    value: 'fixture-legacy-token',
  });
  await db.execute(sql`
    update kortix.project_secrets set strategy = 'broker', consumer = 'git_proxy'
    where project_id = ${ids.get('discovery-legacy-done') as string}
      and name = 'KORTIX_GIT_AUTH_TOKEN'`);
  // This test drives DEPLOYMENT-WIDE scans. If the database holds a GitHub
  // project it does not own, those scans would touch it — so stop instead.
  const foreign = (await db.execute(sql`
    select count(*)::int as n from kortix.projects
    where status <> 'archived'
      and (metadata -> 'git' ->> 'provider' = 'github'
           or (not (metadata ? 'git') and metadata ? 'github'))
      and name not like 'discovery-%'`)) as unknown as Array<{ n: number }>;
  if ((foreign[0]?.n ?? 0) > 0) {
    reason = `database holds ${foreign[0]?.n} GitHub project(s) this test does not own`;
    return;
  }
  ready = true;
});

afterAll(async () => {
  // `prepareRevision` triggers the background worker on a timer. Stop it and
  // let anything already in flight finish, or a tick lands after cleanup and
  // writes a row for a project this suite has just deleted.
  const { awaitRepoSnapshotWorkerIdle, stopRepoSnapshotWorker } = await import('../repo-snapshots/worker');
  stopRepoSnapshotWorker();
  await awaitRepoSnapshotWorkerIdle();
  globalThis.fetch = realFetch;
  server?.stop(true);
  for (const id of created) {
    await db.execute(sql`delete from kortix.project_secrets where project_id = ${id}`).catch(() => {});
    await db
      .execute(sql`delete from kortix.project_git_credentials where project_id = ${id}`)
      .catch(() => {});
    await db.execute(sql`delete from kortix.projects where project_id = ${id}`).catch(() => {});
  }
  // Fixture-scoped, two ways: the ids this test generated, and rows carrying a
  // fixture repository NAME — which only this suite creates, and which catches
  // a row written under an id the stub chose. Never a before/after diff: that
  // would take a concurrent writer's rows with it.
  await db
    .execute(sql`delete from kortix.repo_snapshot_refs where owner = 'kortix-ai' and repo like 'discovery-%'`)
    .catch(() => {});
  for (const repositoryId of ownedRepositoryIds) {
    await db
      .execute(sql`delete from kortix.repo_snapshots where repository_id = ${repositoryId}`)
      .catch(() => {});
    await db
      .execute(sql`delete from kortix.repo_snapshot_refs where repository_id = ${repositoryId}`)
      .catch(() => {});
  }
});

function guard(): boolean {
  if (ready) return true;
  if (!ALLOW_SKIP) throw new Error(`discovery prerequisites missing — ${reason}`);
  console.warn(`[discovery] SKIPPED by KORTIX_REPO_SNAPSHOT_E2E=skip — ${reason}`);
  return false;
}

describe('a failed first preparation recovers without another webhook', () => {
  test('the first webhook leaves NOTHING behind when the lookup fails', async () => {
    if (!guard()) return;
    githubHealthy = false;
    const project = await projectRow(ids.get('discovery-good') as string);
    expect(project).not.toBeNull();

    const outcome = await prepareRefTip(project as never, 'main', 'webhook');
    expect(outcome.prepared).toBe(false);
    expect((outcome as { reason: string }).reason).toContain('GitHub repository lookup failed');

    // The hole finding 18 names: no repository id, therefore no ref row,
    // therefore no retry path keyed on the ref table can ever fire.
    expect(await repositoryIdOf('discovery-good')).toBeNull();
    const refs = (await db.execute(
      sql`select count(*)::int as n from kortix.repo_snapshot_refs where repository_id = ${goodRepoId}`,
    )) as unknown as Array<{ n: number }>;
    expect(refs[0]?.n ?? 0).toBe(0);
  });

  test('several pages of failing projects cannot starve the one behind them', async () => {
    if (!guard()) return;
    githubHealthy = true;
    // One candidate per pass, three broken projects queued ahead of the good
    // one. Each pass must ADVANCE past the failures: an in-memory skip applied
    // after LIMIT would keep returning the same first page and never reach it.
    let discovered = 0;
    let passes = 0;
    while (discovered === 0 && passes < 20) {
      discovered += await discoverUnregisteredProjects(1);
      passes += 1;
    }
    expect(discovered).toBe(1);
    // It sat behind several pages of failures, and every pass moved forward: an
    // in-memory skip applied after LIMIT would have returned the same first
    // page forever and this loop would have run out.
    expect(passes).toBeGreaterThan(BROKEN.length);
    expect(await repositoryIdOf('discovery-good')).toBe(goodRepoId);
    for (const name of BROKEN) expect(await repositoryIdOf(name)).toBeNull();
    // Every one of them was actually attempted, in order, over those passes.
    for (const name of [...BROKEN, 'discovery-good']) {
      expect(lookups).toContain(`/repos/kortix-ai/${name}`);
    }
  });

  test('a failed attempt is recorded in the database, not only in memory', async () => {
    if (!guard()) return;
    const rows = (await db.execute(sql`
      select metadata -> 'git' ->> 'snapshot_discovery_at' as at
      from kortix.projects where project_id = ${ids.get(BROKEN[0] as string)}`)) as unknown as Array<{
      at: string | null;
    }>;
    expect(rows[0]?.at).toBeTruthy();
    // Restart-safe: a new process reads the same ordering from the row.
    expect(Date.parse(rows[0]?.at as string)).toBeGreaterThan(Date.now() - 5 * 60_000);
  });

  test('a registered project is not scanned again', async () => {
    if (!guard()) return;
    await resetRepoSnapshotDiscoveryBackoff(created);
    const before = lookups.length;
    // Every eligible candidate in one pass, markers cleared: the registered
    // project left the candidate set the moment its id was recorded, so it is
    // never looked up again however wide the scan is.
    await discoverUnregisteredProjects(20);
    expect(await repositoryIdOf('discovery-good')).toBe(goodRepoId);
    expect(lookups.slice(before)).not.toContain('/repos/kortix-ai/discovery-good');
    expect(lookups.slice(before).length).toBeGreaterThanOrEqual(BROKEN.length);
  });

  test('an identity persisted without its first ref row is healed', async () => {
    if (!guard()) return;
    expect(await readRepoRef({ provider: 'github', repositoryId: orphanRepoId }, 'main')).toBeNull();

    expect(await scheduleMissingDefaultRefs(10)).toBeGreaterThanOrEqual(1);

    const ref = await readRepoRef({ provider: 'github', repositoryId: orphanRepoId }, 'main');
    expect(ref).not.toBeNull();
    expect(ref?.ref).toBe('main');
    expect(ref?.desiredSha).toBeNull();
    expect(ref?.reconcileAfter).not.toBeNull();
  });

  test('the healed ref row is not rewritten once it exists', async () => {
    if (!guard()) return;
    const before = await readRepoRef({ provider: 'github', repositoryId: orphanRepoId }, 'main');
    await scheduleMissingDefaultRefs(10);
    const after = await readRepoRef({ provider: 'github', repositoryId: orphanRepoId }, 'main');
    expect(after?.updatedAt).toEqual(before?.updatedAt as Date);
  });

  test('no GitHub call ever left the fixture namespace', async () => {
    if (!guard()) return;
    expect(foreignCalls).toEqual([]);
  });

  test('a push records every branch it touched, past the inline budget', async () => {
    if (!guard()) return;
    githubHealthy = true;
    const { prepareRevisionsForPush, PREPARE_REFS_PER_PUSH } = await import('../repo-snapshots/prepare');
    const project = await projectRow(ids.get('discovery-good') as string);
    expect(readRepoSnapshotRepository(project as never).repository?.repositoryId).toBe(goodRepoId);

    // More branches than the inline budget, with a failing one FIRST.
    const refs = [
      'refs/heads/boom',
      ...Array.from({ length: PREPARE_REFS_PER_PUSH + 4 }, (_, index) => `refs/heads/pushed-${index}`),
      // Not a branch: it must not enter the ref table at all.
      'refs/tags/v1',
    ];
    const outcome = await prepareRevisionsForPush(project as never, refs);

    // Every branch is durable, budget or no budget — that is what makes the
    // budget safe.
    expect(outcome.scheduled).toBe(refs.length - 1);
    const rows = (await db.execute(sql`
      select ref, reconcile_after from kortix.repo_snapshot_refs
      where repository_id = ${goodRepoId}`)) as unknown as Array<{
      ref: string;
      reconcile_after: Date | null;
    }>;
    expect(rows.map((r) => r.ref).sort()).toEqual(
      [...refs.slice(0, -1).map((ref) => ref.slice('refs/heads/'.length)), 'main'].sort(),
    );
    for (const row of rows) expect(row.reconcile_after).not.toBeNull();

    // The failing ref did not stop the ones behind it.
    expect(outcome.prepared).toBeGreaterThanOrEqual(PREPARE_REFS_PER_PUSH - 1);
    const boom = await readRepoRef({ provider: 'github', repositoryId: goodRepoId }, 'boom');
    expect(boom?.desiredSha).toBeNull();
    expect(boom?.reconcileAfter).not.toBeNull();
  });

  test('a first push registers the project and keeps every ref', async () => {
    if (!guard()) return;
    githubHealthy = true;
    const { prepareRevisionsForPush, PREPARE_REFS_PER_PUSH } = await import('../repo-snapshots/prepare');
    // Unregistered: this is a project whose FIRST contact is the push itself.
    const projectId = await seedProject('discovery-push');
    expect(readRepoSnapshotRepository((await projectRow(projectId)) as never).repository).toBeNull();

    const refs = Array.from(
      { length: PREPARE_REFS_PER_PUSH + 5 },
      (_, index) => `refs/heads/first-${index}`,
    );
    const outcome = await prepareRevisionsForPush((await projectRow(projectId)) as never, refs);

    // The identity is resolved BEFORE anything is scheduled, so the refs past
    // the inline budget have a key to be stored under instead of vanishing.
    expect(readRepoSnapshotRepository((await projectRow(projectId)) as never).repository?.repositoryId).toBe(
      pushRepoId,
    );
    expect(outcome.scheduled).toBe(refs.length);
    expect(outcome.prepared).toBe(PREPARE_REFS_PER_PUSH);
    const stored = (await db.execute(sql`
      select count(*)::int as n from kortix.repo_snapshot_refs
      where repository_id = ${pushRepoId}`)) as unknown as Array<{ n: number }>;
    expect(stored[0]?.n).toBe(refs.length);
  });

  test('a push during a GitHub outage parks its refs and replays them', async () => {
    if (!guard()) return;
    githubHealthy = true;
    const { prepareRevisionsForPush } = await import('../repo-snapshots/prepare');
    const { pendingPushedRefs } = await import('../repo-snapshots/identity');
    const projectId = await seedProject('discovery-parked');
    const refs = Array.from({ length: 25 }, (_, index) => `refs/heads/parked-${index}`);

    // The identity lookup itself fails. Until this project has a repository id
    // there is nowhere to put a ref row, so the push has to be remembered
    // somewhere else or it is lost entirely.
    parkedProjectFails = true;
    const outcome = await prepareRevisionsForPush((await projectRow(projectId)) as never, refs);
    parkedProjectFails = false;

    expect(outcome).toEqual({ prepared: 0, scheduled: 0 });
    expect(readRepoSnapshotRepository((await projectRow(projectId)) as never).repository).toBeNull();
    expect(pendingPushedRefs((await projectRow(projectId)) as never)).toHaveLength(25);

    // Recovery needs no second push: the discovery pass registers the project
    // and replays what the push parked.
    await resetRepoSnapshotDiscoveryBackoff(created);
    let found = 0;
    for (let pass = 0; pass < 12 && found === 0; pass += 1) {
      found = readRepoSnapshotRepository((await projectRow(projectId)) as never).repository ? 1 : 0;
      if (found === 0) await discoverUnregisteredProjects(1);
    }
    expect(readRepoSnapshotRepository((await projectRow(projectId)) as never).repository?.repositoryId).toBe(
      parkedRepoId,
    );
    const stored = (await db.execute(sql`
      select count(*)::int as n from kortix.repo_snapshot_refs
      where repository_id = ${parkedRepoId}`)) as unknown as Array<{ n: number }>;
    expect(stored[0]?.n).toBe(25);
    expect(pendingPushedRefs((await projectRow(projectId)) as never)).toEqual([]);
  });

  test('a push past the parking bound recovers from the repository itself', async () => {
    if (!guard()) return;
    githubHealthy = true;
    const { prepareRevisionsForPush } = await import('../repo-snapshots/prepare');
    const { pendingPushedRefs, pendingPushedRefsOverflowed } = await import('../repo-snapshots/identity');
    const { drainRegisteredPendingRefs } = await import('../repo-snapshots/worker');
    const projectId = await seedProject('discovery-overflow');
    overflowBranchCount = 1500;
    const refs = Array.from({ length: overflowBranchCount }, (_, index) => `refs/heads/bulk-${index}`);

    // The identity lookup fails, so all 1500 branches have to be remembered
    // somewhere — and 1500 names on a row every session start reads is not a
    // place to remember them.
    parkedProjectFails = true;
    await prepareRevisionsForPush((await projectRow(projectId)) as never, refs);
    parkedProjectFails = false;

    const parked = await projectRow(projectId);
    expect(pendingPushedRefs(parked as never).length).toBeLessThanOrEqual(1000);
    // The truncation is RECORDED, which is what makes it recoverable.
    expect(pendingPushedRefsOverflowed(parked as never)).toBe(true);

    // Registration, then the drain: because the list was truncated, recovery
    // asks the repository for its branches rather than trusting what fitted.
    await resetRepoSnapshotDiscoveryBackoff(created);
    for (let pass = 0; pass < 12; pass += 1) {
      if (readRepoSnapshotRepository((await projectRow(projectId)) as never).repository) break;
      await discoverUnregisteredProjects(1);
    }
    const repositoryId = readRepoSnapshotRepository((await projectRow(projectId)) as never).repository
      ?.repositoryId;
    expect(repositoryId).toBeTruthy();
    ownedRepositoryIds.add(repositoryId as string);
    await drainRegisteredPendingRefs(50);

    const stored = (await db.execute(sql`
      select count(*)::int as n from kortix.repo_snapshot_refs
      where repository_id = ${repositoryId}`)) as unknown as Array<{ n: number }>;
    expect(stored[0]?.n).toBe(overflowBranchCount);
    expect(pendingPushedRefsOverflowed((await projectRow(projectId)) as never)).toBe(false);
    overflowBranchCount = 0;
  });

  test('the worker tick runs both scans', async () => {
    if (!guard()) return;
    const outcome = await runRepoSnapshotTick();
    expect(typeof outcome.discovered).toBe('number');
  });
});

/**
 * The legacy `metadata.github` shape must survive every write this feature
 * makes. `getProjectGitRemote` prefers `metadata.git` whenever it exists, so a
 * partial `git` subtree written by discovery bookkeeping would shadow the
 * legacy subtree and take the project's provider, auth method, installation and
 * repository id with it.
 */
describe('legacy metadata.github projects are not damaged by discovery', () => {
  async function remoteOf(name: string) {
    return getProjectGitRemote((await projectRow(ids.get(name) as string)) as never);
  }

  test('a failed attempt leaves the legacy remote exactly as it was', async () => {
    if (!guard()) return;
    githubHealthy = false;
    await resetRepoSnapshotDiscoveryBackoff(created);
    // Both legacy projects are unregistered, so both are candidates.
    await discoverUnregisteredProjects(20);

    for (const [name, authMethod, installationId] of [
      ['discovery-legacy-app', 'github_app', '4242'],
      ['discovery-legacy-pat', 'pat', null],
    ] as const) {
      const remote = await remoteOf(name);
      expect(remote.provider).toBe('github');
      expect(remote.authMethod).toBe(authMethod);
      expect(remote.installationId).toBe(installationId);
      expect(remote.repoOwner).toBe('kortix-ai');
      expect(remote.repoName).toBe(name);
      expect(remote.externalRepoId).toBeNull();
    }
    // The attempt WAS recorded — in the legacy subtree, not a new one.
    const row = await projectRow(ids.get('discovery-legacy-pat') as string);
    const metadata = (row as { metadata: Record<string, any> }).metadata;
    expect(metadata.git).toBeUndefined();
    expect(metadata.github.snapshot_discovery_at).toBeTruthy();
  });

  test('a recorded id lands under github.repo_id and keeps the remote intact', async () => {
    if (!guard()) return;
    const id = ids.get('discovery-legacy-app') as string;
    const project = await projectRow(id);
    // The exact statement `ensureRepoSnapshotRepository` runs on success.
    await db
      .update(projects)
      .set({
        metadata: metadataMergeSubtree(
          gitMetadataSubtree(project as never),
          repositoryIdFields(project as never, legacyAppRepoId),
        ),
      })
      .where(eq(projects.projectId, id));

    const remote = await remoteOf('discovery-legacy-app');
    expect(remote.provider).toBe('github');
    expect(remote.authMethod).toBe('github_app');
    expect(remote.installationId).toBe('4242');
    expect(remote.externalRepoId).toBe(legacyAppRepoId);
    const metadata = ((await projectRow(id)) as { metadata: Record<string, any> }).metadata;
    expect(metadata.git).toBeUndefined();
    expect(metadata.github.repo_id).toBe(legacyAppRepoId);

    // And it drops out of the scan, exactly like a modern project would.
    await resetRepoSnapshotDiscoveryBackoff(created);
    const before = lookups.length;
    await discoverUnregisteredProjects(20);
    expect(lookups.slice(before)).not.toContain('/repos/kortix-ai/discovery-legacy-app');
  });

  test('an already registered legacy project is never selected', async () => {
    if (!guard()) return;
    await resetRepoSnapshotDiscoveryBackoff(created);
    const before = lookups.length;
    await discoverUnregisteredProjects(20);
    expect(lookups.slice(before)).not.toContain('/repos/kortix-ai/discovery-legacy-done');
    const remote = await remoteOf('discovery-legacy-done');
    expect(remote.externalRepoId).toBe(legacyDoneRepoId);
    expect(remote.authMethod).toBe('pat');
  });

  test('a legacy project reconciles to a queued revision', async () => {
    if (!guard()) return;
    githubHealthy = true;
    await scheduleMissingDefaultRefs(20);
    const row = await readRepoRef({ provider: 'github', repositoryId: legacyDoneRepoId }, 'main');
    expect(row).not.toBeNull();

    // The whole point: the worker's project selector must find a legacy project
    // too, or reconciliation answers "no project can supply source access" and
    // the repaired ref row never advances.
    const outcome = await reconcileRef(row as never);
    expect(outcome).toEqual({ ok: true, sha: fixtureSha });

    const queued = await findRepoSnapshot(
      normalizeRepoSnapshotIdentity({
        repositoryId: legacyDoneRepoId,
        owner: 'kortix-ai',
        repo: 'discovery-legacy-done',
        commitSha: fixtureSha,
      }),
    );
    expect(queued?.status).toBe('queued');
    expect(queued?.sourceProjectId).toBe(ids.get('discovery-legacy-done') as string);
    expect((await readRepoRef({ provider: 'github', repositoryId: legacyDoneRepoId }, 'main'))?.desiredSha).toBe(
      fixtureSha,
    );
  });

  test('a legacy project missing its ref row is healed under the legacy id', async () => {
    if (!guard()) return;
    await db.execute(
      sql`delete from kortix.repo_snapshot_refs where repository_id = ${legacyDoneRepoId}`,
    );
    await db.execute(sql`delete from kortix.repo_snapshots where repository_id = ${legacyDoneRepoId}`);
    expect(await readRepoRef({ provider: 'github', repositoryId: legacyDoneRepoId }, 'main')).toBeNull();

    await scheduleMissingDefaultRefs(20);
    const ref = await readRepoRef({ provider: 'github', repositoryId: legacyDoneRepoId }, 'main');
    expect(ref).not.toBeNull();
    expect(ref?.owner).toBe('kortix-ai');
    expect(ref?.repo).toBe('discovery-legacy-done');
  });
});
