/**
 * My Kortix, the built-in agent (slug `meta`), and its kortix.yaml switch
 * `builtin_agents.my_kortix` (absent = on). The agent page and the CLI read
 * `GET /agents/meta/config`; it answered `404 No agent "meta" declared in
 * kortix.yaml` for an agent `/detail` lists. In-process app, real DB, real git.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { accountMembers, accounts, projectMembers, projectSessions, projects } from '@kortix/db';
import { db } from '../shared/db';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';
import { insertIntoView } from './helpers/compat-views';
import { createLocalGitUpstream, type LocalGitUpstream } from './helpers/local-git-upstream';

const manifest = (builtin: string) => `kortix_version: 3
default_agent: kortix
${builtin}agents:
  kortix:
    description: The project agent.
    prompt: You do the work.
`;

const ACCOUNT = crypto.randomUUID();
const OWNER = crypto.randomUUID();
/** No `builtin_agents` key: My Kortix is on. */
const ON = crypto.randomUUID();
/** `builtin_agents: { my_kortix: false }`. */
const OFF = crypto.randomUUID();
/** No key, and the project's legacy `meta_agent` switch is off. */
const LEGACY_OFF = crypto.randomUUID();
const upstreams: LocalGitUpstream[] = [];
const secrets: Record<string, string> = {};

beforeAll(async () => {
  const absent = createLocalGitUpstream('builtin-agents-absent', { 'kortix.yaml': manifest('') });
  const off = createLocalGitUpstream('builtin-agents-off', {
    'kortix.yaml': manifest('builtin_agents:\n  my_kortix: false\n'),
  });
  upstreams.push(absent, off);
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'builtin-agents-test' });
  await insertIntoView(db, accountMembers, [{ userId: OWNER, accountId: ACCOUNT, accountRole: 'owner', isSuperAdmin: false }]);
  for (const [projectId, repoUrl, metadata] of [
    [ON, absent.repoUrl, {}],
    [OFF, off.repoUrl, {}],
    [LEGACY_OFF, absent.repoUrl, { experimental: { meta_agent: false } }],
  ] as const) {
    await db.insert(projects).values({ projectId, accountId: ACCOUNT, name: `builtin-agents-${projectId.slice(0, 8)}`, repoUrl, metadata });
    await insertIntoView(db, projectMembers, [{ accountId: ACCOUNT, projectId, userId: OWNER, projectRole: 'manager' }]);
    secrets[projectId] = (
      await createAccountToken({ accountId: ACCOUNT, userId: OWNER, projectId, name: 'builtin-agents-test', agentGrant: null as any })
    ).secretKey;
  }
});

afterAll(async () => {
  await db.execute(sql`delete from kortix.account_tokens where account_id = ${ACCOUNT}`);
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  for (const upstream of upstreams.reverse()) upstream.remove();
});

const call = (projectId: string, path: string, init: RequestInit = {}) =>
  app.request(`/v1/projects/${projectId}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${secrets[projectId]}`, 'Content-Type': 'application/json', ...init.headers },
  });

interface Detail {
  config: {
    default_agent: string | null;
    builtin_agents?: { my_kortix: boolean };
    agents: Array<{ name: string; platform?: boolean; description: string | null }>;
  };
}

async function detail(projectId: string): Promise<Detail['config']> {
  const res = await call(projectId, '/detail');
  expect(res.status).toBe(200);
  return ((await res.json()) as Detail).config;
}

describe('builtin_agents.my_kortix absent (on)', () => {
  test('GET /detail lists My Kortix first and makes it the default agent', async () => {
    const config = await detail(ON);
    expect(config.builtin_agents).toEqual({ my_kortix: true });
    expect(config.default_agent).toBe('meta');
    expect(config.agents.map((agent) => agent.name)).toEqual(['meta', 'kortix']);
    expect(config.agents[0]).toMatchObject({ platform: true });
    expect(config.agents[0]?.description).toContain('The one agent you talk to');
  });

  test('GET /agents/meta/config answers the read-only built-in view, not 404', async () => {
    const res = await call(ON, '/agents/meta/config');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      agent: 'meta',
      builtin: 'my_kortix',
      editable: false,
      block: null,
      schema_version: 3,
      default_agent: 'kortix',
    });
  });

  test('a write to the built-in agent is refused with builtin_agent_managed, and nothing commits', async () => {
    const config = await call(ON, '/agents/meta/config', { method: 'PUT', body: JSON.stringify({ connectors: 'all' }) });
    expect(config.status).toBe(409);
    expect(await config.json()).toMatchObject({ code: 'builtin_agent_managed' });
    const scope = await call(ON, '/agents/meta/scope', { method: 'PUT', body: JSON.stringify({ connectors: 'all' }) });
    expect(scope.status).toBe(409);
    expect(await scope.json()).toMatchObject({ code: 'builtin_agent_managed' });
    expect((await detail(ON)).agents.map((agent) => agent.name)).toEqual(['meta', 'kortix']);
  });

  test('an undeclared agent still answers 404 agent_not_found', async () => {
    const res = await call(ON, '/agents/ghost/config');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'agent_not_found' });
  });
});

describe('builtin_agents.my_kortix: false (off)', () => {
  test('GET /detail lists only the declared agents and keeps the manifest default', async () => {
    const config = await detail(OFF);
    expect(config.builtin_agents).toEqual({ my_kortix: false });
    expect(config.default_agent).toBe('kortix');
    expect(config.agents.map((agent) => agent.name)).toEqual(['kortix']);
  });

  test('`meta` then has no config view', async () => {
    const res = await call(OFF, '/agents/meta/config');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'agent_not_found' });
  });

  test('POST /sessions naming `meta` is refused with 409 builtin_agent_disabled, and no session row is written', async () => {
    const res = await call(OFF, '/sessions', { method: 'POST', body: JSON.stringify({ agent_name: 'meta' }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'builtin_agent_disabled' });
    expect(await db.select().from(projectSessions).where(eq(projectSessions.projectId, OFF))).toEqual([]);
  });
});

describe('no builtin_agents key, legacy meta_agent switch off', () => {
  test('the project stays off until kortix.yaml sets the key', async () => {
    const config = await detail(LEGACY_OFF);
    expect(config.builtin_agents).toEqual({ my_kortix: false });
    expect(config.agents.map((agent) => agent.name)).toEqual(['kortix']);
  });

  test('POST /sessions naming `meta` is refused there too', async () => {
    const res = await call(LEGACY_OFF, '/sessions', { method: 'POST', body: JSON.stringify({ agent_name: 'meta' }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'builtin_agent_disabled' });
  });
});
