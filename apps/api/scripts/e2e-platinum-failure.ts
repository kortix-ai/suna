/**
 * Failure-mode verification: when Platinum rejects the create, does the
 * Kortix session row reach status='error' with errorMessage populated, and
 * does no orphan Platinum sandbox get left behind?
 *
 * Strategy: temporarily override PLATINUM_TEMPLATE to a bogus value via
 * env, so provider.create() POSTs a template that doesn't exist; Platinum
 * replies 400; session-sandbox's catch path should mark the row as error.
 */

import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { accounts, projects, sessionSandboxes } from '@kortix/db';
import { db } from '../src/shared/db';
import { provisionSessionSandbox } from '../src/platform/services/session-sandbox';

const sandboxId = randomUUID(), accountId = randomUUID(), projectId = randomUUID(), userId = randomUUID();

async function main() {
  // Surgical override: replace the cached config.PLATINUM_TEMPLATE before
  // any provider call. The provider reads config.PLATINUM_TEMPLATE lazily
  // via getter each time create() runs — so monkey-patching process.env
  // alone isn't enough; we have to mutate the config object's PLATINUM_TEMPLATE.
  const { config } = await import('../src/config');
  (config as any).PLATINUM_TEMPLATE = 'tpl_does_not_exist_e2e';

  console.log('→ seed account + project');
  await db.insert(accounts).values({ accountId, name: 'fail-acct', personalAccount: true });
  await db.insert(projects).values({
    projectId, accountId, name: 'fail-project',
    repoUrl: 'https://example.invalid/fail.git', defaultBranch: 'main', manifestPath: 'kortix.toml',
  });

  console.log('→ provision with bogus template');
  await provisionSessionSandbox({
    sandboxId, accountId, projectId, userId, provider: 'platinum',
    gitProject: { projectId, repoUrl: 'https://example.invalid/fail.git', defaultBranch: 'main', manifestPath: 'kortix.toml' },
  });

  console.log('→ polling for terminal status (45s budget)');
  const deadline = Date.now() + 45_000;
  let final: typeof sessionSandboxes.$inferSelect | undefined;
  while (Date.now() < deadline) {
    const [r] = await db.select().from(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, sandboxId)).limit(1);
    if (r && (r.status === 'active' || r.status === 'error')) { final = r; break; }
    await new Promise((res) => setTimeout(res, 500));
  }
  if (!final) throw new Error('timeout waiting for terminal status');

  console.log(`\nfinal row: status=${final.status} externalId=${final.externalId}`);
  console.log(`metadata: ${JSON.stringify(final.metadata, null, 2)}`);

  try {
    if (final.status !== 'error') throw new Error(`expected status=error, got ${final.status}`);
    if (final.externalId) throw new Error(`bad: orphan externalId set despite failure: ${final.externalId}`);
    const md = final.metadata as Record<string, unknown>;
    if (!md?.lastProvisioningError && !md?.errorMessage) throw new Error('no error message captured in metadata');

    console.log('\nPLATINUM FAILURE-MODE: PASS');
  } finally {
    await db.delete(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, sandboxId)).catch(() => {});
    await db.delete(projects).where(eq(projects.projectId, projectId)).catch(() => {});
    await db.delete(accounts).where(eq(accounts.accountId, accountId)).catch(() => {});
  }
}

main().catch((e) => { console.error('\nPLATINUM FAILURE-MODE: FAIL'); console.error(e); process.exit(1); });
