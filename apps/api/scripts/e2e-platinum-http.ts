/**
 * Live HTTP route e2e:
 *   - Seeds account + account_members + project in the local Kortix DB.
 *   - Mints a CLI PAT (kortix_pat_...) bound to that user/account.
 *   - Assumes the Kortix API is already running on :8008 (start with
 *     `bun --env-file=.env run --hot src/index.ts` in another terminal).
 *   - POSTs to /v1/projects/:projectId/sessions with the PAT.
 *   - Polls /v1/projects/:projectId/sessions/:sessionId until the session
 *     reports a sandbox URL (or a failure).
 *   - Verifies the linked session_sandboxes row also shows status=active.
 *   - Tears down: removes Platinum sandbox, deletes DB rows, revokes PAT.
 *
 * What this proves on top of the lower-level scripts: the request lands
 * via Hono → IAM gates pass → createProjectSession path triggers
 * provisionSessionSandbox → response shape is what the dashboard expects.
 */

import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { accounts, accountMembers, projects, projectSessions, sessionSandboxes } from '@kortix/db';
import { db } from '../src/shared/db';
import { createAccountToken } from '../src/repositories/account-tokens';
import { getProvider } from '../src/platform/providers';

const API_BASE = 'http://127.0.0.1:8008';

async function waitHealthy(deadlineMs: number) {
  // ops/health is auth-gated → 401 just means server is up. Any HTTP response
  // (including 401 / 404) proves the listener is bound.
  while (Date.now() < deadlineMs) {
    try {
      const r = await fetch(`${API_BASE}/v1/ops/health`).catch(() => null);
      if (r) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  console.log('→ waiting for Kortix API on :8008');
  if (!(await waitHealthy(Date.now() + 60_000))) {
    throw new Error('Kortix API not healthy on http://127.0.0.1:8008 — start with: cd apps/api && bun --env-file=.env run src/index.ts');
  }
  console.log('✓ API healthy');

  const accountId = randomUUID(), projectId = randomUUID(), userId = randomUUID();
  console.log(`→ seed account=${accountId} project=${projectId} user=${userId}`);
  await db.insert(accounts).values({ accountId, name: `http-${accountId.slice(0,8)}`, personalAccount: true });
  await db.insert(accountMembers).values({ userId, accountId, accountRole: 'owner', isSuperAdmin: false });
  await db.insert(projects).values({
    projectId, accountId, name: 'http-e2e',
    repoUrl: 'https://github.com/kortix-ai/platinum.git', defaultBranch: 'main', manifestPath: 'kortix.toml',
  });

  console.log('→ mint CLI PAT');
  const tok = await createAccountToken({ accountId, userId, name: 'e2e' });
  console.log(`  publicKey=${tok.publicKey}`);

  console.log('→ POST /v1/projects/:projectId/sessions');
  const startMs = Date.now();
  const res = await fetch(`${API_BASE}/v1/projects/${projectId}/sessions`, {
    method: 'POST',
    headers: { 'authorization': `Bearer ${tok.secretKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ agent_name: 'default', initial_prompt: 'e2e probe' }),
  });
  const text = await res.text();
  console.log(`  HTTP ${res.status} (${Date.now() - startMs}ms)`);
  if (!res.ok) throw new Error(`session create failed: ${res.status} ${text}`);
  const session = JSON.parse(text);
  console.log(`  sessionId=${session.session_id ?? session.id ?? session.sessionId}`);
  const sessionId = session.session_id ?? session.id ?? session.sessionId;
  if (!sessionId) throw new Error(`no session id in response: ${text}`);

  console.log('→ poll session for sandbox URL (90s)');
  const deadline = Date.now() + 90_000;
  let lastStatus = '';
  let finalSandboxRow: typeof sessionSandboxes.$inferSelect | undefined;
  while (Date.now() < deadline) {
    const r = await fetch(`${API_BASE}/v1/projects/${projectId}/sessions/${sessionId}`, {
      headers: { authorization: `Bearer ${tok.secretKey}` },
    });
    if (!r.ok) { await new Promise((res) => setTimeout(res, 1000)); continue; }
    const j = await r.json() as any;
    if (j.status !== lastStatus) { console.log(`  session.status=${j.status} sandbox_url=${j.sandbox_url ?? '<none>'}`); lastStatus = j.status; }
    if (j.status === 'running' && j.sandbox_url) {
      const [sbx] = await db.select().from(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, sessionId)).limit(1);
      if (sbx?.status === 'active' && sbx.externalId) { finalSandboxRow = sbx; break; }
    }
    if (j.status === 'failed') throw new Error(`session failed: ${j.error}`);
    await new Promise((res) => setTimeout(res, 1500));
  }
  if (!finalSandboxRow) throw new Error('timeout waiting for session to reach running+active');

  console.log(`\n=== live HTTP path verified ===`);
  console.log(`  HTTP session.id=${sessionId}`);
  console.log(`  HTTP session.status=running (via /v1/projects/.../sessions/...)`);
  console.log(`  DB session_sandboxes.status=${finalSandboxRow.status}`);
  console.log(`  DB session_sandboxes.externalId=${finalSandboxRow.externalId}`);
  console.log(`  DB session_sandboxes.baseUrl=${(finalSandboxRow.baseUrl ?? '').slice(0, 80)}...`);

  try {
    if (finalSandboxRow.status !== 'active') throw new Error(`expected active, got ${finalSandboxRow.status}`);
    if (!finalSandboxRow.baseUrl?.includes('sbx.platinum.dev')) throw new Error('bad baseUrl');
    console.log('\nPLATINUM HTTP-ROUTE E2E: PASS');
  } finally {
    console.log('→ teardown');
    if (finalSandboxRow.externalId) {
      try { await getProvider('platinum').remove(finalSandboxRow.externalId); console.log('  ✓ Platinum sandbox removed'); } catch (e) { console.warn(`  remove failed: ${e}`); }
    }
    await db.delete(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, sessionId)).catch(() => {});
    await db.delete(projectSessions).where(eq(projectSessions.sessionId, sessionId)).catch(() => {});
    await db.delete(projects).where(eq(projects.projectId, projectId)).catch(() => {});
    await db.delete(accountMembers).where(eq(accountMembers.accountId, accountId)).catch(() => {});
    await db.delete(accounts).where(eq(accounts.accountId, accountId)).catch(() => {});
    console.log('  ✓ DB rows removed');
  }
}

main().catch((e) => { console.error('\nPLATINUM HTTP-ROUTE E2E: FAIL'); console.error(e); process.exit(1); });
