/**
 * End-to-end test for the workspace-less sandbox-templates refactor.
 *
 * Drives the local dev API as a real PAT-authenticated user:
 *
 *   1. Mint a PAT for the first local owner account (same pattern as the
 *      other e2e-* scripts).
 *   2. Provision a fresh Freestyle-backed project (seed_starter=true). With
 *      the refactor, the starter no longer ships `.kortix/Dockerfile`, so the
 *      project has zero custom templates and only the platform default is
 *      available.
 *   3. Verify GET /sandboxes shape: at least the platform default present,
 *      default_slug === "default".
 *   4. Verify GET /snapshots shape: { templates, builds, templates_error }.
 *   5. Verify GET /sandbox-health shape: { primary_*, ready, building, … }.
 *   6. POST /snapshots/rebuild (empty body + explicit {slug:"default"})
 *      both return 202 with slug === "default".
 *   7. Create a session WITHOUT sandbox_slug → uses platform default.
 *   8. Create a session WITH sandbox_slug === "default" → also default.
 *   9. Create a session with a bogus slug → session row created, async fail.
 *  10. List sessions, then delete + cleanup.
 *
 * Exits non-zero on the first mismatch. Cleans up everything it creates.
 *
 *     cd apps/api && bun run scripts/e2e-sandbox-templates.ts
 *
 * Env:
 *   BACKEND_URL       backend to hit (default http://localhost:8008)
 *   WAIT_FOR_SESSION  set to 1 to poll the first session until running
 *   KEEP              set to 1 to leave the project + sessions in place
 */

import { eq } from 'drizzle-orm';
import { accountMembers, accountTokens, creditAccounts } from '@kortix/db';
import { db } from '../src/shared/db';
import { createAccountToken } from '../src/repositories/account-tokens';

const BACKEND = (process.env.BACKEND_URL || 'http://localhost:8008').replace(/\/+$/, '');
const PAT_NAME = 'e2e-sandbox-templates';

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

async function mintToken(): Promise<{ token: string; tokenId: string; accountId: string }> {
  const members = await db.select().from(accountMembers).limit(50);
  const owner = members.find((m) => m.accountRole === 'owner');
  if (!owner) throw new Error('no local owner account found — sign in via the dashboard first');
  const minted = await createAccountToken({
    accountId: owner.accountId,
    userId: owner.userId,
    name: PAT_NAME,
  });
  return { token: minted.secretKey, tokenId: minted.tokenId, accountId: owner.accountId };
}

/**
 * Ensure the test account has a credit_account row so the billing gate passes.
 * Returns true if we created it (and should drop it on cleanup), false if it
 * already existed (leave it alone).
 */
async function ensureCreditAccount(accountId: string): Promise<boolean> {
  const existing = await db.select().from(creditAccounts).where(eq(creditAccounts.accountId, accountId)).limit(1);
  if (existing.length > 0) return false;
  await db.insert(creditAccounts).values({
    accountId,
    balance: '1000.0000',
    lifetimeGranted: '1000.0000',
    billingModel: 'legacy',
  });
  return true;
}

async function main() {
  console.log(`\n[e2e] sandbox templates  →  ${BACKEND}\n`);

  // ── 0. Pre-flight ─────────────────────────────────────────────────────
  const healthRes = await fetch(`${BACKEND}/health`).then((r) => r.status).catch(() => 0);
  assert(healthRes === 200, 'backend healthy', `GET /health → ${healthRes}`);

  const { token, tokenId, accountId } = await mintToken();
  ok(`minted PAT (tokenId=${tokenId.slice(0, 8)}…)`);
  const createdCreditRow = await ensureCreditAccount(accountId);
  if (createdCreditRow) ok(`bootstrapped credit_account for test (will drop on cleanup)`);

  // ── 1. Provision project ──────────────────────────────────────────────
  const projectName = `e2e-tpl-${Math.floor(Date.now() / 1000)}`;
  log(`provision project "${projectName}"…`);
  const prov = await api('POST', '/projects/provision', token, {
    name: projectName,
    seed_starter: true,
  });
  assert(prov.status === 201, 'POST /projects/provision → 201', `got ${prov.status}: ${prov.text.slice(0, 200)}`);
  const projectId: string = prov.json.project_id ?? prov.json.projectId;
  assert(typeof projectId === 'string' && projectId.length > 0, 'project_id returned');
  assert(prov.json.seeded === true, 'project was seeded with starter');
  log(`project: ${projectId}`);

  let projectDeleted = false;
  const cleanup = async () => {
    if (process.env.KEEP === '1') {
      log(`KEEP=1 — leaving project ${projectId} intact`);
      return;
    }
    if (projectDeleted) return;
    log(`DELETE project…`);
    const del = await api('DELETE', `/projects/${projectId}`, token);
    if (del.status >= 200 && del.status < 300) ok(`project deleted`);
    else bad(`project delete failed`, `status ${del.status}: ${del.text.slice(0, 200)}`);
    projectDeleted = true;
    // Revoke the PAT we minted so we don't leave it behind.
    await db.delete(accountTokens).where(eq(accountTokens.tokenId, tokenId)).catch(() => {});
    if (createdCreditRow) {
      await db.delete(creditAccounts).where(eq(creditAccounts.accountId, accountId)).catch(() => {});
    }
  };

  try {
    // Give pre-build a beat to insert a build log row (if any).
    await sleep(1_000);

    // ── 1b. POST /manifest/validate — schema validator ──────────────────
    log(`POST /projects/${projectId.slice(0, 8)}/manifest/validate…`);
    const goodToml = `kortix_version = 1\n[project]\nname = "x"\n[[sandboxes]]\nslug = "ml"\nimage = "python:3.12-slim"\n`;
    const okValidate = await api('POST', `/projects/${projectId}/manifest/validate`, token, { raw: goodToml });
    assert(okValidate.status === 200, 'POST /manifest/validate (good) → 200');
    assert(okValidate.json.valid === true, 'good manifest reports valid:true');

    const badToml = `kortix_version = 1\n[[sandboxes]]\nslug = "default"\nimage = "ubuntu:latest"\n\n[sandbox]\ndockerfile = ".kortix/Dockerfile"\n`;
    const failValidate = await api('POST', `/projects/${projectId}/manifest/validate`, token, { raw: badToml });
    assert(failValidate.status === 200, 'POST /manifest/validate (bad) → 200');
    assert(failValidate.json.valid === false, 'bad manifest reports valid:false');
    const issuePaths = (failValidate.json.issues ?? []).map((i: any) => i.path);
    assert(issuePaths.includes('sandboxes[0].slug'), 'reports reserved slug');
    assert(issuePaths.includes('sandbox'), 'reports legacy [sandbox] table');

    const noBody = await api('POST', `/projects/${projectId}/manifest/validate`, token, {});
    assert(noBody.status === 400, 'POST /manifest/validate (no body) → 400');

    // ── 2. GET /sandboxes ───────────────────────────────────────────────
    log(`GET /projects/${projectId.slice(0, 8)}/sandboxes…`);
    const sandboxes = await api('GET', `/projects/${projectId}/sandboxes`, token);
    assert(sandboxes.status === 200, 'GET /sandboxes → 200', `status ${sandboxes.status}`);
    assert(
      Array.isArray(sandboxes.json.items) && sandboxes.json.items.length >= 1,
      'sandboxes has ≥1 template',
    );
    const platformDefault = sandboxes.json.items.find((t: any) => t.is_default === true && t.slug === 'default');
    assert(!!platformDefault, 'platform default present (is_default=true, slug="default")');
    assert(platformDefault.source === 'platform', 'platform default source === "platform"');
    assert(sandboxes.json.default_slug === 'default', 'default_slug === "default"');
    log(`  default daytona_state=${platformDefault.daytona_state}`);

    // ── 3. GET /snapshots ───────────────────────────────────────────────
    const snaps = await api('GET', `/projects/${projectId}/snapshots`, token);
    assert(snaps.status === 200, 'GET /snapshots → 200', `status ${snaps.status}`);
    assert('templates' in snaps.json, '/snapshots has key "templates"');
    assert('builds' in snaps.json, '/snapshots has key "builds"');
    assert('templates_error' in snaps.json, '/snapshots has key "templates_error"');
    ok(`templates=${snaps.json.templates.length} builds=${snaps.json.builds.length}`);

    // ── 4. GET /sandbox-health ──────────────────────────────────────────
    const health = await api('GET', `/projects/${projectId}/sandbox-health`, token);
    assert(health.status === 200, 'GET /sandbox-health → 200', `status ${health.status}`);
    for (const key of ['primary_slug', 'primary_template', 'ready', 'building', 'latest_build', 'latest_failure']) {
      assert(key in health.json, `/sandbox-health has key "${key}"`);
    }
    assert(health.json.primary_slug === 'default', 'primary_slug === "default"');
    log(`  ready=${health.json.ready} building=${health.json.building}`);

    // ── 5. Rebuild (no body) → default ──────────────────────────────────
    const rebuild1 = await api('POST', `/projects/${projectId}/snapshots/rebuild`, token, {});
    assert(rebuild1.status === 202, 'POST /snapshots/rebuild (no body) → 202', `status ${rebuild1.status}: ${rebuild1.text.slice(0, 200)}`);
    assert(rebuild1.json.slug === 'default', 'rebuild slug === "default" (default body)');
    ok(`deleted_existing=${rebuild1.json.deleted_existing}`);

    // ── 5b. Rebuild explicit slug=default ──────────────────────────────
    const rebuild2 = await api('POST', `/projects/${projectId}/snapshots/rebuild`, token, { slug: 'default' });
    assert(rebuild2.status === 202, 'POST /snapshots/rebuild slug=default → 202', `status ${rebuild2.status}`);
    assert(rebuild2.json.slug === 'default', 'rebuild slug echoes "default"');

    // ── 5c. Template CRUD (image-based) ─────────────────────────────────
    log(`POST /projects/${projectId.slice(0, 8)}/sandbox-templates (image)…`);
    const createTpl = await api('POST', `/projects/${projectId}/sandbox-templates`, token, {
      slug: 'python-slim',
      name: 'Python 3.12 slim',
      image: 'python:3.12-slim',
      cpu: 2,
      memory_gb: 4,
      disk_gb: 20,
    });
    assert(createTpl.status === 201, 'POST /sandbox-templates → 201', `status ${createTpl.status}: ${createTpl.text.slice(0, 200)}`);
    const tplId: string = createTpl.json.template_id;
    assert(typeof tplId === 'string' && tplId.length > 0, 'template_id returned');

    // List should now include it
    const listAfterCreate = await api('GET', `/projects/${projectId}/sandbox-templates`, token);
    assert(listAfterCreate.status === 200, 'GET /sandbox-templates → 200');
    const found = (listAfterCreate.json?.items ?? []).find((t: any) => t.slug === 'python-slim');
    assert(!!found, 'created template appears in /sandbox-templates list');
    assert(found.source === 'ui', 'created template source === "ui"');
    assert(found.image === 'python:3.12-slim', 'image echoed');

    // PATCH — update name + change image to a different tag
    const patchTpl = await api('PATCH', `/projects/${projectId}/sandbox-templates/${tplId}`, token, {
      name: 'Python slim (updated)',
      image: 'python:3.12.7-slim',
    });
    assert(patchTpl.status === 200, 'PATCH /sandbox-templates/:id → 200');
    assert(patchTpl.json.slug === 'python-slim', 'patch preserves slug');

    // Reject duplicate slug
    const dup = await api('POST', `/projects/${projectId}/sandbox-templates`, token, {
      slug: 'python-slim',
      image: 'python:3.12-slim',
    });
    assert(dup.status === 409, 'duplicate slug → 409');

    // Reject reserved slug
    const reserved = await api('POST', `/projects/${projectId}/sandbox-templates`, token, {
      slug: 'default',
      image: 'python:3.12-slim',
    });
    assert(reserved.status === 409, 'reserved slug "default" → 409');

    // Reject both image AND dockerfile_path
    const both = await api('POST', `/projects/${projectId}/sandbox-templates`, token, {
      slug: 'oops',
      image: 'a:b',
      dockerfile_path: '.kortix/Dockerfile',
    });
    assert(both.status === 400, 'both image + dockerfile_path → 400');

    // Build trigger (fire-and-forget)
    const buildTpl = await api('POST', `/projects/${projectId}/sandbox-templates/${tplId}/build`, token, {});
    assert(buildTpl.status === 202, 'POST /sandbox-templates/:id/build → 202');
    assert(buildTpl.json.slug === 'python-slim', 'build echoes slug');

    // ── 5d. Session create with bogus slug → 400 (synchronous) ────────────
    const bogusEarly = await api('POST', `/projects/${projectId}/sessions`, token, { sandbox_slug: 'nonexistent' });
    assert(bogusEarly.status === 400, 'POST /sessions slug=nonexistent → 400');
    assert(bogusEarly.json?.code === 'UNKNOWN_SANDBOX_TEMPLATE', 'error code UNKNOWN_SANDBOX_TEMPLATE');

    // ── 6. Session create — no slug ─────────────────────────────────────
    log(`POST /projects/${projectId.slice(0, 8)}/sessions (no slug)…`);
    const s1 = await api('POST', `/projects/${projectId}/sessions`, token, {});
    assert(s1.status === 201, 'POST /sessions (no slug) → 201', `status ${s1.status}: ${s1.text.slice(0, 200)}`);
    const sid1: string = s1.json.session_id ?? s1.json.id;
    assert(typeof sid1 === 'string' && sid1.length > 0, 'session_id returned (no slug)');

    // ── 7. Session create — explicit default ───────────────────────────
    const s2 = await api('POST', `/projects/${projectId}/sessions`, token, { sandbox_slug: 'default' });
    assert(s2.status === 201, 'POST /sessions slug=default → 201', `status ${s2.status}: ${s2.text.slice(0, 200)}`);
    const sid2: string = s2.json.session_id ?? s2.json.id;
    assert(typeof sid2 === 'string' && sid2.length > 0, 'session_id returned (slug=default)');

    // ── 8. Session create — custom (image-based) template ─────────────
    const s3 = await api('POST', `/projects/${projectId}/sessions`, token, { sandbox_slug: 'python-slim' });
    assert(s3.status === 201, 'POST /sessions slug=python-slim → 201', `status ${s3.status}: ${s3.text.slice(0, 200)}`);
    const sid3: string = s3.json.session_id ?? s3.json.id;
    assert(typeof sid3 === 'string', 'session_id returned (custom slug)');

    // ── 9. List sessions ────────────────────────────────────────────────
    const list = await api('GET', `/projects/${projectId}/sessions`, token);
    assert(list.status === 200, 'GET /sessions → 200');
    const listItems: any[] = Array.isArray(list.json) ? list.json : (list.json?.items ?? []);
    const seen = new Set(listItems.map((it: any) => it.session_id ?? it.id));
    assert(seen.has(sid1) && seen.has(sid2), 'both non-bogus sessions appear in list', `saw [${[...seen].slice(0, 5).join(', ')}]`);

    if (process.env.WAIT_FOR_SESSION === '1') {
      log(`waiting for session ${sid1.slice(0, 8)} to become running (≤7m)…`);
      const deadline = Date.now() + 7 * 60 * 1000;
      let last = 'unknown';
      while (Date.now() < deadline) {
        const r = await api('GET', `/projects/${projectId}/sessions/${sid1}`, token);
        last = String(r.json?.status ?? r.json?.session?.status ?? 'unknown');
        log(`  status=${last}`);
        if (last === 'running') break;
        if (last === 'failed' || last === 'error') {
          bad(`session ${sid1.slice(0, 8)} failed waiting for running`, `status=${last}`);
          break;
        }
        await sleep(5_000);
      }
      if (last === 'running') ok(`session ${sid1.slice(0, 8)} reached "running"`);
    }

    // ── 10. Delete sessions + custom template ───────────────────────────
    if (process.env.KEEP !== '1') {
      for (const sid of [sid1, sid2, sid3]) {
        if (!sid) continue;
        const del = await api('DELETE', `/projects/${projectId}/sessions/${sid}`, token);
        if (del.status >= 200 && del.status < 300) ok(`deleted session ${sid.slice(0, 8)}`);
        else bad(`failed to delete session ${sid.slice(0, 8)}`, `status ${del.status}: ${del.text.slice(0, 200)}`);
      }
      // Delete the custom template we created.
      const delTpl = await api('DELETE', `/projects/${projectId}/sandbox-templates/${tplId}`, token);
      assert(delTpl.status === 204, 'DELETE /sandbox-templates/:id → 204');
      // Confirm gone.
      const listAfterDelete = await api('GET', `/projects/${projectId}/sandbox-templates`, token);
      const still = (listAfterDelete.json?.items ?? []).find((t: any) => t.slug === 'python-slim');
      assert(!still, 'deleted template no longer in list');
    }
  } finally {
    await cleanup();
  }

  console.log(`\n[e2e] done — ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`\n[e2e] fatal:`, err instanceof Error ? err.message : err);
  process.exit(1);
});
