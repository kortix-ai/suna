/**
 * End-to-end test for the sandbox-template BUILD LIFECYCLE — the state machine,
 * the global platform default, orphaned-build reconciliation, cross-source
 * build dedup, and the explicit rebuild of custom (toml/UI) templates.
 *
 * Drives the live dev API over HTTP (curl-equivalent `fetch`) as a real
 * PAT-authenticated user, and asserts directly against the DB + provider for
 * the pieces that aren't visible over HTTP. Designed to run FAST: it never
 * waits for a real ~10-minute Daytona build to finish — it verifies the
 * lifecycle bookkeeping (build-log rows, template state, reconcile, dedup)
 * which is what actually broke.
 *
 *   cd apps/api && bun run scripts/e2e-sandbox-template-lifecycle.ts
 *
 * Env:
 *   BACKEND_URL   backend to hit (default http://localhost:8008)
 *   KEEP          set to 1 to leave the project + rows in place
 *
 * Exits non-zero on the first failed assertion. Cleans up everything it makes.
 */

import { and, eq } from 'drizzle-orm';
import {
  accountMembers,
  accountTokens,
  creditAccounts,
  projects as projectsTable,
  projectSnapshotBuilds,
  sandboxTemplates,
} from '@kortix/db';
import { db } from '../src/shared/db';
import { createAccountToken } from '../src/repositories/account-tokens';
import {
  reconcileProjectTemplates,
  reconcileStaleBuilds,
  ensurePlatformDefaultImage,
} from '../src/snapshots/builder';
import { computeTemplateIdentity, invalidateTemplateCache, resolveTemplateBySlug } from '../src/snapshots/templates';
import { getSandboxProvider } from '../src/snapshots/providers';
import type { GitBackedProject } from '../src/projects/git';

const BACKEND = (process.env.BACKEND_URL || 'http://localhost:8008').replace(/\/+$/, '');
const PAT_NAME = 'e2e-sandbox-template-lifecycle';

const t0 = Date.now();
const ms = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (m: string) => console.log(`[${ms()}] ${m}`);
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));

let passed = 0;
let failed = 0;
function ok(m: string) {
  passed += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${m}`);
}
function bad(m: string, detail = '') {
  failed += 1;
  console.log(`  \x1b[31m✗ ${m}\x1b[0m${detail ? ` — ${detail}` : ''}`);
}
function assert(cond: unknown, msg: string, detail = ''): asserts cond {
  if (cond) ok(msg);
  else {
    bad(msg, detail);
    throw new Error(`step failed: ${msg}${detail ? ` — ${detail}` : ''}`);
  }
}

async function api(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`${BACKEND}/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, text };
}

async function mintToken(): Promise<{ token: string; tokenId: string; accountId: string; userId: string }> {
  const members = await db.select().from(accountMembers).limit(50);
  const owner = members.find((m) => m.accountRole === 'owner');
  if (!owner) throw new Error('no local owner account found — sign in via the dashboard first');
  const minted = await createAccountToken({ accountId: owner.accountId, userId: owner.userId, name: PAT_NAME });
  return { token: minted.secretKey, tokenId: minted.tokenId, accountId: owner.accountId, userId: owner.userId };
}

async function ensureCreditAccount(accountId: string): Promise<boolean> {
  const existing = await db.select().from(creditAccounts).where(eq(creditAccounts.accountId, accountId)).limit(1);
  if (existing.length > 0) return false;
  await db.insert(creditAccounts).values({
    accountId, balance: '1000.0000', lifetimeGranted: '1000.0000', billingModel: 'legacy',
  });
  return true;
}

/**
 * Count build-log rows for a project + snapshot name. We filter by the snapshot
 * NAME only (never by timestamp): the local Dockerized Postgres clock is skewed
 * vs the host wall clock, so a host-`Date` cutoff would wrongly exclude
 * DB-`now()`-stamped rows. Every run uses a unique (novel) snapshot name, so
 * the only rows that can carry it are the ones this run just opened.
 */
async function countBuildRows(projectId: string, snapshotName: string): Promise<number> {
  const rows = await db
    .select({ id: projectSnapshotBuilds.buildId })
    .from(projectSnapshotBuilds)
    .where(and(
      eq(projectSnapshotBuilds.projectId, projectId),
      eq(projectSnapshotBuilds.snapshotName, snapshotName),
    ));
  return rows.length;
}

async function main() {
  console.log(`\n[e2e] sandbox template lifecycle  →  ${BACKEND}\n`);

  const healthRes = await fetch(`${BACKEND}/health`).then((r) => r.status).catch(() => 0);
  assert(healthRes === 200, 'backend healthy', `GET /health → ${healthRes}`);

  const { token, tokenId, accountId } = await mintToken();
  ok(`minted PAT (tokenId=${tokenId.slice(0, 8)}…)`);
  const createdCreditRow = await ensureCreditAccount(accountId);
  if (createdCreditRow) ok('bootstrapped credit_account for test');

  // ── 1. Platform default is GLOBAL (one shared row, no project_id) ────────
  log('verify platform default is a single global row…');
  const sharedRows = await db.select().from(sandboxTemplates).where(eq(sandboxTemplates.isShared, true));
  assert(sharedRows.length === 1, 'exactly one is_shared platform template exists', `got ${sharedRows.length}`);
  const def = sharedRows[0];
  assert(def.slug === 'default', 'shared template slug === "default"');
  assert(def.projectId === null, 'shared template has NULL project_id (not project-scoped)');
  assert(def.source === 'platform', 'shared template source === "platform"');
  log(`  default state=${def.providerState} snapshot=${def.providerSnapshotName}`);

  // Startup pre-build should have made it active. If a fresh DB/fingerprint
  // drift left it not-yet-active, mint it now so the rest of the test has a
  // real active snapshot to point reconcile at.
  if (def.providerState !== 'active') {
    log('  default not active — running ensurePlatformDefaultImage() (may take minutes)…');
    const r = await ensurePlatformDefaultImage({ source: 'startup' });
    ok(`default image ensured: ${r.snapshotName} (built=${r.built})`);
  } else {
    ok('platform default already active (startup pre-build / cache hit)');
  }
  const activeDefault = (await db.select().from(sandboxTemplates).where(eq(sandboxTemplates.isShared, true)))[0];
  assert(activeDefault.providerState === 'active', 'platform default is active', `state=${activeDefault.providerState}`);
  const activeDefaultSnapshot = activeDefault.providerSnapshotName!;

  // ── 2. Provision project — must NOT build the default ────────────────────
  const projectName = `e2e-tpllc-${Math.floor(Date.now() / 1000)}`;
  log(`provision project "${projectName}"…`);
  const prov = await api('POST', '/projects/provision', token, { name: projectName, seed_starter: true });
  assert(prov.status === 201, 'POST /projects/provision → 201', `got ${prov.status}: ${prov.text.slice(0, 200)}`);
  const projectId: string = prov.json.project_id ?? prov.json.projectId;
  assert(typeof projectId === 'string' && projectId.length > 0, 'project_id returned');
  log(`project: ${projectId}`);

  let projectDeleted = false;
  const cleanup = async () => {
    if (process.env.KEEP === '1') { log(`KEEP=1 — leaving project ${projectId} intact`); return; }
    if (projectDeleted) return;
    const del = await api('DELETE', `/projects/${projectId}`, token);
    if (del.status >= 200 && del.status < 300) ok('project deleted via API');
    else bad('project delete failed', `status ${del.status}`);
    projectDeleted = true;
    // DELETE /projects is a soft-delete (archive) — hard-delete the row here so
    // the test leaves no cruft. The FK cascade clears its templates + build log.
    await db.delete(projectsTable).where(eq(projectsTable.projectId, projectId)).catch(() => {});
    await db.delete(accountTokens).where(eq(accountTokens.tokenId, tokenId)).catch(() => {});
    if (createdCreditRow) await db.delete(creditAccounts).where(eq(creditAccounts.accountId, accountId)).catch(() => {});
  };

  try {
    await sleep(2_000); // let any project-create pre-build fire

    // No build-log row for the default should have been created by project-create:
    // the default is global, already active → cache hit, no row, no rebuild.
    // (Brand-new project → any such row could only have come from this create.)
    const defaultBuildRows = await db
      .select()
      .from(projectSnapshotBuilds)
      .where(eq(projectSnapshotBuilds.projectId, projectId));
    const defaultRowsForDefaultSlug = defaultBuildRows.filter(
      (r) => (r.metadata as any)?.slug === 'default',
    );
    assert(
      defaultRowsForDefaultSlug.length === 0,
      'project-create did NOT enqueue a build of the global default',
      `found ${defaultRowsForDefaultSlug.length} rows`,
    );

    // And the default shows ready over HTTP (cache hit, project-independent).
    const snaps1 = await api('GET', `/projects/${projectId}/snapshots`, token);
    assert(snaps1.status === 200, 'GET /snapshots → 200');
    const defView = snaps1.json.templates.find((t: any) => t.slug === 'default');
    assert(!!defView && defView.ready === true, 'default template ready over HTTP (cache hit)');
    assert('built_from_commit' in defView, '/snapshots template exposes built_from_commit');

    // ── 3. Orphaned-build reconcile (THE stuck-"Building" bug) ─────────────
    log('reconcile: orphaned "building" rows…');
    const stale = new Date(Date.now() - 60 * 60 * 1000); // 1h ago — well past cutoff

    // (a) stale row pointing at the ACTIVE default snapshot → should close ready
    const [staleActive] = await db.insert(projectSnapshotBuilds).values({
      accountId, projectId, commitSha: '', branch: 'default',
      snapshotName: activeDefaultSnapshot, contentHash: 'x'.repeat(64),
      status: 'building', metadata: { source: 'background', slug: 'default' }, startedAt: stale,
    }).returning({ id: projectSnapshotBuilds.buildId });

    // (b) stale row pointing at a snapshot that does NOT exist → should fail
    const [staleMissing] = await db.insert(projectSnapshotBuilds).values({
      accountId, projectId, commitSha: '', branch: 'ghost',
      snapshotName: 'kortix-tpl-deadbeefdead', contentHash: 'y'.repeat(64),
      status: 'building', metadata: { source: 'manual', slug: 'ghost' }, startedAt: stale,
    }).returning({ id: projectSnapshotBuilds.buildId });

    // (c) FRESH row pointing at a missing snapshot → must be LEFT building
    const [freshBuilding] = await db.insert(projectSnapshotBuilds).values({
      accountId, projectId, commitSha: '', branch: 'fresh',
      snapshotName: 'kortix-tpl-stillbuilding', contentHash: 'z'.repeat(64),
      status: 'building', metadata: { source: 'manual', slug: 'fresh' }, startedAt: new Date(),
    }).returning({ id: projectSnapshotBuilds.buildId });

    const recon = await reconcileStaleBuilds({ projectId });
    log(`  reconcileStaleBuilds → ${JSON.stringify(recon)}`);
    assert(recon.checked >= 2, 'reconcile checked the stale rows', `checked=${recon.checked}`);

    const after = await db.select().from(projectSnapshotBuilds)
      .where(eq(projectSnapshotBuilds.projectId, projectId));
    const byId = (id: string) => after.find((r) => r.buildId === id)!;
    assert(byId(staleActive.id).status === 'ready', 'stale row on an ACTIVE snapshot → closed "ready"');
    assert(byId(staleActive.id).finishedAt !== null, '  …and finishedAt set');
    assert(byId(staleMissing.id).status === 'failed', 'stale row on a MISSING snapshot → closed "failed"');
    assert(!!byId(staleMissing.id).error, '  …with an error message');
    assert(byId(freshBuilding.id).status === 'building', 'FRESH row left "building" (under cutoff)');

    // It also self-heals on a plain HTTP read of /snapshots.
    await db.update(projectSnapshotBuilds)
      .set({ status: 'building', finishedAt: null, startedAt: stale })
      .where(eq(projectSnapshotBuilds.buildId, staleActive.id));
    const snaps2 = await api('GET', `/projects/${projectId}/snapshots`, token);
    const healed = (snaps2.json.builds ?? []).find((b: any) => b.build_id === staleActive.id);
    assert(healed && healed.status === 'ready', 'GET /snapshots self-heals an orphaned "building" row');

    // A throwaway project shell — image templates never read git, and the
    // default path ignores it. Used for the in-script identity/reconcile calls.
    const projectRow = (await db.select().from(projectsTable).where(eq(projectsTable.projectId, projectId)).limit(1))[0];
    const projectShell: GitBackedProject = {
      projectId,
      repoUrl: projectRow.repoUrl,
      defaultBranch: projectRow.defaultBranch,
      manifestPath: projectRow.manifestPath,
    };
    const provider = getSandboxProvider('daytona');

    // Use UNIQUE, non-pullable image refs so every identity is novel — the
    // snapshot has never existed on the provider, so the build path is
    // guaranteed cold (no cache hit, no async-delete race) and a build-log row
    // is opened (in runInlineBuild) before the pull fails. Deterministic, fast,
    // and no quota leak (a failed pull never produces an active snapshot).
    const uniq = `${Date.now().toString(36)}`;
    const dedupImage = `e2e.invalid/dedup-${uniq}:latest`;
    const driftImageA = `e2e.invalid/drift-a-${uniq}:latest`;
    const driftImageB = `e2e.invalid/drift-b-${uniq}:latest`;

    // ── 4. Create the dedup template ───────────────────────────────────────
    log('create custom (UI) image template…');
    const createTpl = await api('POST', `/projects/${projectId}/sandbox-templates`, token, {
      slug: 'dedup-img', name: 'Dedup image', image: dedupImage,
      cpu: 2, memory_gb: 4, disk_gb: 20,
    });
    assert(createTpl.status === 201, 'POST /sandbox-templates → 201', `status ${createTpl.status}: ${createTpl.text.slice(0, 200)}`);
    const tplId: string = createTpl.json.template_id;
    assert(typeof tplId === 'string' && tplId.length > 0, 'template_id returned');

    const created = await resolveTemplateBySlug(projectShell, 'dedup-img');
    const tplSnapshot = (await computeTemplateIdentity(projectShell, created)).snapshotName;
    assert(tplSnapshot.startsWith('kortix-tpl-'), 'custom template snapshot name is kortix-tpl-*', tplSnapshot);

    const listed = await api('GET', `/projects/${projectId}/sandbox-templates`, token);
    const tplView = (listed.json?.items ?? []).find((t: any) => t.slug === 'dedup-img');
    assert(!!tplView, 'custom template appears in /sandbox-templates list');
    assert(tplView.source === 'ui', 'custom template source === "ui"');

    // ── 5. Cross-source dedup — 3 concurrent COLD builds → ONE build-log row ─
    log('dedup: fire 3 concurrent /build for the same template (cold)…');
    const burst = await Promise.all([
      api('POST', `/projects/${projectId}/sandbox-templates/${tplId}/build`, token, {}),
      api('POST', `/projects/${projectId}/sandbox-templates/${tplId}/build`, token, {}),
      api('POST', `/projects/${projectId}/sandbox-templates/${tplId}/build`, token, {}),
    ]);
    assert(burst.every((r) => r.status === 202), 'all 3 /build calls → 202');
    await sleep(3_000); // let the in-process dedup + log insert settle
    const dedupRows = await countBuildRows(projectId, tplSnapshot);
    assert(dedupRows === 1, 'three concurrent cold builds opened EXACTLY one build-log row (deduped)', `opened ${dedupRows}`);
    ok(`  dedup collapsed 3 builds → ${dedupRows} row for ${tplSnapshot}`);

    // Delete the dedup template so its (failing, fire-and-forget) build can't
    // stamp a stray state onto a row the drift test below reads.
    await api('DELETE', `/projects/${projectId}/sandbox-templates/${tplId}`, token);
    await provider.deleteSnapshot(tplSnapshot).catch(() => {});

    // ── 6. Explicit rebuild logic — drift detection (reconcileProjectTemplates) ─
    // Run on a DEDICATED template so the only non-shared template reconcile sees
    // is this one — making the aggregate rebuilt count an exact signal.
    log('reconcileProjectTemplates: skip when current, rebuild when drifted…');
    const createDrift = await api('POST', `/projects/${projectId}/sandbox-templates`, token, {
      slug: 'drift-img', name: 'Drift image', image: driftImageA, cpu: 2, memory_gb: 4, disk_gb: 20,
    });
    assert(createDrift.status === 201, 'POST drift template → 201');
    const driftTplId: string = createDrift.json.template_id;

    // Simulate "already built & current": stamp the row active at its identity.
    invalidateTemplateCache(projectId); // drop the script's stale burst-cache after the API mutation
    const resolved = await resolveTemplateBySlug(projectShell, 'drift-img');
    const identity = await computeTemplateIdentity(projectShell, resolved);
    await db.update(sandboxTemplates).set({
      providerState: 'active',
      contentHash: identity.contentHash,
      providerSnapshotName: identity.snapshotName,
    }).where(eq(sandboxTemplates.templateId, driftTplId));

    const reconCurrent = await reconcileProjectTemplates(projectShell, { accountId, source: 'cr-merge' });
    log(`  current → ${JSON.stringify(reconCurrent)}`);
    assert(reconCurrent.rebuilt === 0, 'current template is NOT rebuilt (identity matches)', JSON.stringify(reconCurrent));

    // Now drift it: PATCH to a different image → API clears state to "missing".
    const patch = await api('PATCH', `/projects/${projectId}/sandbox-templates/${driftTplId}`, token, { image: driftImageB });
    assert(patch.status === 200, 'PATCH template image → 200');
    const driftedRow = (await db.select().from(sandboxTemplates).where(eq(sandboxTemplates.templateId, driftTplId)).limit(1))[0];
    assert(driftedRow.providerState === 'missing', 'identity-affecting PATCH reset provider_state → "missing"');

    invalidateTemplateCache(projectId); // see the post-PATCH image, not the cached pre-PATCH one
    const driftedResolved = await resolveTemplateBySlug(projectShell, 'drift-img');
    const driftIdentity = await computeTemplateIdentity(projectShell, driftedResolved);
    assert(driftIdentity.snapshotName !== identity.snapshotName, 'drift produced a NEW snapshot identity');

    const reconDrift = await reconcileProjectTemplates(projectShell, { accountId, source: 'cr-merge' });
    log(`  drifted → ${JSON.stringify(reconDrift)}`);
    assert(reconDrift.rebuilt >= 1, 'drifted template IS rebuilt', JSON.stringify(reconDrift));
    await sleep(2_500);
    const driftRows = await countBuildRows(projectId, driftIdentity.snapshotName);
    assert(driftRows >= 1, 'a build-log row was opened for the drifted identity', `rows=${driftRows}`);
    ok(`  drifted rebuild → snapshot ${driftIdentity.snapshotName}`);

    // ── 7. Delete the drift template + reap the test snapshot ──────────────
    const delTpl = await api('DELETE', `/projects/${projectId}/sandbox-templates/${driftTplId}`, token);
    assert(delTpl.status === 204, 'DELETE /sandbox-templates/:id → 204');
    await provider.deleteSnapshot(driftIdentity.snapshotName).catch(() => {});
  } finally {
    await cleanup();
  }

  console.log(`\n[e2e] done — ${passed} passed, ${failed} failed`);
  // Force exit — reconcile/build helpers kick fire-and-forget Daytona builds
  // whose promises would otherwise keep the event loop alive for minutes.
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n[e2e] fatal:`, err instanceof Error ? err.message : err);
  process.exit(1);
});
