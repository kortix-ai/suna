/**
 * HTTP-level regression (in-process app, real DB, real git mirror): an agent
 * NAME the project's manifest does not declare is rejected by every route that
 * takes one — never answered with an empty success.
 *
 * Before the fix, two write/read paths failed open on an unknown name:
 *  - GET /agents/:name/config answered 200 with `block: null` for a name that
 *    is not in kortix.yaml, so `kortix agents config does-not-exist --json`
 *    and `kortix agents scope does-not-exist --show --json` exited 0 with an
 *    empty block / the full default scope (KRTX-2071, KRTX-2535), and the
 *    dashboard's agent editor rendered an empty editor for a phantom agent.
 *    The dashboard's use-agent-config contract already documents the intended
 *    shape: "An agent missing from the manifest answers 404".
 *  - PUT /model-defaults?scope=agent&agentName=X accepted any X and stored an
 *    orphan pin no gateway resolution ever reads — visible only as "Pins
 *    without an agent" in `kortix agents ls` (KRTX-2535).
 *
 * DELETE keeps its lenient clear-on-miss: clearing a stale pin for an agent
 * that has since been removed from the manifest is the cleanup path.
 */
import { describe, expect, test, afterAll } from 'bun:test';
// deepseek-v4.1-flash, the model pinned below, is served by Platinum inference.
// A placeholder key makes this deployment serve it, as prod does. Never reached.
process.env.PLATINUM_INFERENCE_API_KEY = 'not-a-real-platinum-key-agent-name-gate';
const { db } = await import('../shared/db');
const { app } = await import('../index');
const { eq, sql } = await import('drizzle-orm');
const {
  accounts,
  projects,
  accountModelPreferences,
  accountMembers,
  projectMembers,
} = await import('@kortix/db');
const { createAccountToken } = await import('../repositories/account-tokens');
const { insertIntoView } = await import('./helpers/compat-views');
const { createLocalGitUpstream } = await import('./helpers/local-git-upstream');
import type { LocalGitUpstream } from './helpers/local-git-upstream';

const V2_MANIFEST = `# yaml-language-server: $schema=https://kortix.com/schema/kortix.v2.schema.json
kortix_version: 2
default_agent: kortix
project:
  name: name-gate
agents:
  kortix:
    file: agents/kortix.md
    connectors: all
    secrets: all
    kortix_permissions: all
  research:
    file: agents/research.md
    connectors: none
`;

const V1_MANIFEST = `kortix_version = 1
[project]
name = "name-gate-v1"

[[agents]]
name = "kortix"
file = "agents/kortix.md"
`;

interface Ctx {
  accountId: string;
  projectId: string;
  /** The account owner the tokens mint for — membership is what authorizes. */
  userId: string;
  upstream: LocalGitUpstream;
}
let ctx: Ctx | null = null;
const created: Ctx[] = [];
const minted: string[] = [];

/** One isolated project per describe block: fresh ids each time (a second
 *  insert of the same account id would collide before afterAll runs). */
async function seed(manifestFile: 'kortix.yaml' | 'kortix.toml', manifest: string): Promise<void> {
  const accountId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const upstream = createLocalGitUpstream('agent-name-gate', { [manifestFile]: manifest });
  await db.insert(accounts).values({ accountId, name: 'agent-name-gate-test' });
  await db.insert(projects).values({
    projectId,
    accountId,
    name: 'agent-name-gate-test-project',
    repoUrl: upstream.repoUrl,
  });
  await insertIntoView(db, accountMembers, [
    { userId, accountId, accountRole: 'owner', isSuperAdmin: false },
  ]);
  await insertIntoView(db, projectMembers, [
    { accountId, projectId, userId, projectRole: 'manager' },
  ]);
  ctx = { accountId, projectId, userId, upstream };
  created.push(ctx);
}

async function ownerToken(): Promise<string> {
  const t = await createAccountToken({
    accountId: ctx!.accountId,
    userId: ctx!.userId,
    projectId: ctx!.projectId,
    name: 'agent-name-gate-test',
    agentGrant: null as any,
  });
  minted.push(t.tokenId);
  return t.secretKey;
}

async function agentPinRows(accountId: string): Promise<Array<{ scope_key: string; model: string }>> {
  const rows = (await db.execute(sql`
    select scope_key, model from kortix.account_model_preferences
    where account_id = ${accountId} and scope = 'agent'`)) as unknown as Array<{
    scope_key: string;
    model: string;
  }>;
  return rows;
}

afterAll(async () => {
  for (const tokenId of minted) {
    await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  }
  for (const c of created) {
    await db.delete(accountModelPreferences).where(eq(accountModelPreferences.accountId, c.accountId));
    await db.delete(projects).where(eq(projects.accountId, c.accountId));
    await db.delete(accounts).where(eq(accounts.accountId, c.accountId));
    c.upstream.remove();
  }
});

describe('GET /agents/:name/config — a name the manifest does not declare is 404, not an empty block', () => {
  test('a DECLARED agent reads back its governance block (unchanged)', async () => {
    await seed('kortix.yaml', V2_MANIFEST);
    const secret = await ownerToken();
    const res = await app.request(`/v1/projects/${ctx!.projectId}/agents/kortix/config`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schema_version).toBe(2);
    expect(body.block).toMatchObject({ connectors: 'all', secrets: 'all' });
  });

  test('an UNDECLARED agent answers 404 agent_not_found naming the declared agents', async () => {
    const secret = await ownerToken();
    const res = await app.request(`/v1/projects/${ctx!.projectId}/agents/does-not-exist/config`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('agent_not_found');
    // The error names the valid agents, so `agents config`'s hint is fillable
    // (KRTX-2071).
    expect(body.error).toContain('Declared agents:');
    expect(body.error).toContain('kortix, research');
  });
});

describe('PUT /model-defaults?scope=agent — an undeclared agentName is refused, not pinned', () => {
  test('an UNDECLARED agent answers 409 agent_not_found and stores NO pin', async () => {
    const secret = await ownerToken();
    const res = await app.request(
      `/v1/projects/${ctx!.projectId}/model-defaults?scope=agent&agentName=${encodeURIComponent('does-not-exist')}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'agent', agentName: 'does-not-exist', model: 'deepseek-v4.1-flash' }),
      },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('agent_not_found');
    expect(await agentPinRows(ctx!.accountId)).toEqual([]);
  });

  test('a DECLARED agent still pins (unchanged)', async () => {
    // Clear the agent pins the earlier tests in this file wrote, so the
    // read-back below shows exactly this test's row.
    await db.execute(
      sql`delete from kortix.account_model_preferences where account_id = ${ctx!.accountId} and scope = 'agent'`,
    );
    const secret = await ownerToken();
    const res = await app.request(
      `/v1/projects/${ctx!.projectId}/model-defaults?scope=agent&agentName=kortix`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'agent', agentName: 'kortix', model: 'deepseek-v4.1-flash' }),
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    const rows = await agentPinRows(ctx!.accountId);
    expect(rows).toEqual([{ scope_key: 'kortix', model: 'deepseek-v4.1-flash' }]);
  });

  test('DELETE keeps the lenient clear-on-miss (stale-pin cleanup path)', async () => {
    const secret = await ownerToken();
    const res = await app.request(
      `/v1/projects/${ctx!.projectId}/model-defaults?scope=agent&agentName=${encodeURIComponent('does-not-exist')}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${secret}` } },
    );
    expect(res.status).toBe(200);
  });
});

describe('a malformed agent entry is manifest_malformed, not agent_not_found (PUT mirrors the GET)', () => {
  test('an entry that exists but is not a table answers 400 on both gates', async () => {
    await seed('kortix.yaml', `${V2_MANIFEST}\n  broken: not-a-table\n`);
    const secret = await ownerToken();
    const res = await app.request(
      `/v1/projects/${ctx!.projectId}/model-defaults?scope=agent&agentName=${encodeURIComponent('broken')}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'agent', agentName: 'broken', model: 'deepseek-v4.1-flash' }),
      },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('manifest_malformed');
    expect(await agentPinRows(ctx!.accountId)).toEqual([]);
    // The config GET answers the same manifest state with the same code —
    // the two gates must not disagree about what "malformed" means.
    const get = await app.request(`/v1/projects/${ctx!.projectId}/agents/broken/config`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(get.status).toBe(400);
    expect((await get.json()).code).toBe('manifest_malformed');
  });
});

describe('v1 manifests — `[[agents]]` array is the roster', () => {
  test('a declared v1 agent still reads back schema_version 1 (unchanged)', async () => {
    await seed('kortix.toml', V1_MANIFEST);
    const secret = await ownerToken();
    const res = await app.request(`/v1/projects/${ctx!.projectId}/agents/kortix/config`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schema_version).toBe(1);
    expect(body.block).toBeNull();
  });

  test('an undeclared v1 agent answers 404, not the old empty success', async () => {
    const secret = await ownerToken();
    const res = await app.request(`/v1/projects/${ctx!.projectId}/agents/does-not-exist/config`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('agent_not_found');
  });
});
