/**
 * Integration test (real local DB): secret access is ONE source of truth, so a
 * change made in the Members "Resource access" card is visible in the Secret
 * "Who can access this" dialog and vice-versa.
 *
 * Card path   → addSecretResourceGrant / listSecretResourceGrants / removeSecretResourceGrant
 * Dialog path → setSecretSharing (replace) / scopeToIntent (read back)
 * Both read/write project_secret_grants + share_scope. This proves they agree.
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import { projectSecrets } from '@kortix/db';
import { db } from '../shared/db';
import {
  addSecretResourceGrant,
  listSecretResourceGrants,
  removeSecretResourceGrant,
  writeSharedProjectSecret,
} from '../projects/secrets';
import { loadGrants, scopeToIntent, setSecretSharing } from '../executor/share';

let ctx: { projectId: string } | null = null;
const SUFFIX = crypto.randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '');
const SECRET = `E2E_SYNC_${SUFFIX}`;
const M1 = crypto.randomUUID();
const M2 = crypto.randomUUID();
const G1 = crypto.randomUUID();

async function secretId(): Promise<string> {
  const [r] = await db
    .select({ id: projectSecrets.secretId, scope: projectSecrets.shareScope })
    .from(projectSecrets)
    .where(and(eq(projectSecrets.projectId, ctx!.projectId), eq(projectSecrets.name, SECRET)))
    .limit(1);
  return r!.id;
}
async function shareScope(): Promise<string> {
  const [r] = await db
    .select({ scope: projectSecrets.shareScope })
    .from(projectSecrets)
    .where(and(eq(projectSecrets.projectId, ctx!.projectId), eq(projectSecrets.name, SECRET)))
    .limit(1);
  return r!.scope;
}
/** What the Resource-access card would show for this secret. */
async function cardPrincipals(): Promise<Set<string>> {
  const rows = (await listSecretResourceGrants(ctx!.projectId)).filter((g) => g.name === SECRET);
  return new Set(rows.map((g) => `${g.principalType}:${g.principalId}`));
}
/** What the Secret dialog would show (the share intent). */
async function dialogIntent() {
  const id = await secretId();
  return scopeToIntent(await shareScope(), (await loadGrants([id])).get(id) ?? []);
}
/** The principals a dialog intent restricts to (mode-agnostic). Note: the share
 *  model labels a single member + no groups as `private` ("Only me"), so we
 *  compare the underlying principals, which is what actually gates access. */
function intentPrincipals(intent: Awaited<ReturnType<typeof dialogIntent>>): Set<string> {
  if (intent.mode === 'private') return new Set([intent.ownerId]);
  if (intent.mode === 'members') return new Set([...intent.memberIds, ...intent.groupIds]);
  return new Set();
}

beforeAll(async () => {
  const rows = (await db.execute(
    sql`select project_id from kortix.projects limit 1`,
  )) as unknown as Array<{ project_id: string }>;
  if (!rows[0]) return;
  ctx = { projectId: rows[0].project_id };
  await writeSharedProjectSecret({ projectId: ctx.projectId, name: SECRET, value: 'v' });
});

afterAll(async () => {
  if (!ctx) return;
  await db
    .delete(projectSecrets)
    .where(and(eq(projectSecrets.projectId, ctx.projectId), eq(projectSecrets.name, SECRET)));
});

describe('secret access — one source of truth across both surfaces', () => {
  test('card grant (member) shows in the dialog + flips the secret to restricted', async () => {
    if (!ctx) { console.warn('[integration] no project in local DB — skipping'); return; }
    expect(await shareScope()).toBe('project'); // starts open

    await addSecretResourceGrant({ projectId: ctx.projectId, name: SECRET, principalType: 'member', principalId: M1 });

    expect(await shareScope()).toBe('restricted');
    expect(await cardPrincipals()).toEqual(new Set([`member:${M1}`]));
    // The dialog restricts to the same principal (labeled "Only me" for a lone member).
    expect(intentPrincipals(await dialogIntent())).toEqual(new Set([M1]));
  });

  test('dialog save (member + department) shows in the card', async () => {
    if (!ctx) return;
    await setSecretSharing(await secretId(), { mode: 'members', memberIds: [M2], groupIds: [G1] });
    // Card reflects the dialog's write exactly.
    expect(await cardPrincipals()).toEqual(new Set([`member:${M2}`, `group:${G1}`]));
  });

  test('card add is additive; removing the last grant reverts to project-wide', async () => {
    if (!ctx) return;
    // Add M1 back via the card — additive, joins M2 + G1.
    await addSecretResourceGrant({ projectId: ctx.projectId, name: SECRET, principalType: 'member', principalId: M1 });
    expect(await cardPrincipals()).toEqual(new Set([`member:${M1}`, `member:${M2}`, `group:${G1}`]));

    // Remove them all via the card; the last removal reverts to open.
    const grants = (await listSecretResourceGrants(ctx.projectId)).filter((g) => g.name === SECRET);
    for (const g of grants) await removeSecretResourceGrant(g.grantId, ctx.projectId);

    expect(await cardPrincipals()).toEqual(new Set());
    expect(await shareScope()).toBe('project');
    expect((await dialogIntent()).mode).toBe('project');
  });
});
