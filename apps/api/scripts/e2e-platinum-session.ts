/**
 * Session-level e2e: exercises the full session-sandbox provisioning
 * pipeline against Platinum from inside Kortix code.
 *
 * Steps:
 *   1. Insert a synthetic account + project row in the local Kortix DB.
 *   2. Call provisionSessionSandbox(...) — same entrypoint the real session
 *      creation route hits.
 *   3. Poll session_sandboxes until status flips to 'active' (success) or
 *      'error' (failure surfaced).
 *   4. Print the DB row + tear down the Platinum sandbox AND the DB rows.
 *
 * Asserts on:
 *   - status === 'active'
 *   - baseUrl populated (the Platinum expose URL)
 *   - externalId starts with 'sbx_'
 *   - metadata.platinumSandboxId matches externalId
 *
 * Pre-reqs: local Supabase running on :54322; migration 59
 * (platinum enum) applied; apps/api/.env points at prod Platinum with a
 * valid pt_live_* token.
 *
 * Run with:
 *   cd apps/api && bun --env-file=.env run scripts/e2e-platinum-session.ts
 */

import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { accounts, projects, sessionSandboxes } from '@kortix/db';
import { db } from '../src/shared/db';
import { provisionSessionSandbox } from '../src/platform/services/session-sandbox';
import { getProvider } from '../src/platform/providers';

const sandboxId = randomUUID();
const accountId = randomUUID();
const projectId = randomUUID();
const userId    = randomUUID();

async function main() {
  console.log('→ seed account + project rows');
  await db.insert(accounts).values({ accountId, name: 'e2e-platinum', personalAccount: true });
  await db.insert(projects).values({
    projectId,
    accountId,
    name: 'e2e-platinum-project',
    repoUrl: 'https://example.invalid/e2e/platinum.git',
    defaultBranch: 'main',
    manifestPath: 'kortix.toml',
  });
  console.log(`✓ accountId=${accountId} projectId=${projectId}`);

  console.log('→ provisionSessionSandbox()');
  const { row, created } = await provisionSessionSandbox({
    sandboxId,
    accountId,
    projectId,
    userId,
    provider: 'platinum',
    gitProject: {
      projectId,
      repoUrl: 'https://example.invalid/e2e/platinum.git',
      defaultBranch: 'main',
      manifestPath: 'kortix.toml',
    },
  });
  console.log(`✓ initial row created=${created} status=${row.status}`);

  console.log('→ polling sessionSandboxes for terminal status (up to 60s)');
  const deadline = Date.now() + 60_000;
  let final: typeof sessionSandboxes.$inferSelect | undefined;
  while (Date.now() < deadline) {
    const [r] = await db.select().from(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, sandboxId)).limit(1);
    if (!r) throw new Error('session row vanished mid-poll');
    if (r.status === 'active' || r.status === 'error') { final = r; break; }
    await new Promise((res) => setTimeout(res, 1000));
  }
  if (!final) throw new Error('timeout waiting for terminal status');

  console.log(`\n=== session_sandboxes row ===`);
  console.log(JSON.stringify({
    sandboxId: final.sandboxId,
    provider: final.provider,
    status: final.status,
    externalId: final.externalId,
    baseUrl: final.baseUrl,
    metadata: final.metadata,
  }, null, 2));

  try {
    if (final.status !== 'active') {
      throw new Error(`expected status='active', got '${final.status}'`);
    }
    if (!final.externalId || !final.externalId.startsWith('sbx_')) {
      throw new Error(`bad externalId: ${final.externalId}`);
    }
    if (!final.baseUrl || !final.baseUrl.includes('sbx.platinum.dev')) {
      throw new Error(`baseUrl missing or wrong host: ${final.baseUrl}`);
    }
    const md = final.metadata as Record<string, unknown> | null;
    if ((md?.platinumSandboxId as string) !== final.externalId) {
      throw new Error(`metadata.platinumSandboxId mismatch: ${md?.platinumSandboxId} vs ${final.externalId}`);
    }

    console.log('\nPLATINUM SESSION E2E: PASS');
  } finally {
    console.log('\n→ teardown');
    if (final.externalId) {
      try {
        await getProvider('platinum').remove(final.externalId);
        console.log('✓ Platinum sandbox removed');
      } catch (e) { console.warn(`! Platinum remove failed: ${e}`); }
    }
    await db.delete(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, sandboxId)).catch(() => {});
    await db.delete(projects).where(eq(projects.projectId, projectId)).catch(() => {});
    await db.delete(accounts).where(eq(accounts.accountId, accountId)).catch(() => {});
    console.log('✓ DB rows removed');
  }
}

main().catch((e) => {
  console.error('\nPLATINUM SESSION E2E: FAIL');
  console.error(e);
  process.exit(1);
});
