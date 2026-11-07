/**
 * My Kortix, the built-in agent (slug `mykortix`), and its kortix.yaml switch
 * `builtin_agents.my_kortix` (`true` = on; anything else off). The agent page and the CLI read
 * `GET /agents/meta/config`; it answered `404 No agent "meta" declared in
 * kortix.yaml` for an agent `/detail` lists. In-process app, real DB, real git.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { accountMembers, accounts, projectMembers, projectSessions, projects } from '@kortix/db';
import { db } from '../shared/db';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';
import { insertIntoView } from './helpers/compat-views';
import { createLocalGitUpstream, type LocalGitUpstream } from './helpers/local-git-upstream';

const manifest = (builtin: string, defaultAgent = 'kortix') => `default_agent: ${defaultAgent}
${builtin}agents:
  kortix:
    description: The project agent.
    prompt: You do the work.
`;

const ACCOUNT = crypto.randomUUID();
const OWNER = crypto.randomUUID();
/** `builtin_agents: { my_kortix: true }`, `default_agent: kortix`. */
const ON = crypto.randomUUID();
/** `builtin_agents: { my_kortix: true }`, `default_agent: mykortix`. */
const ON_DEFAULT = crypto.randomUUID();
/** No `builtin_agents` key: My Kortix is off. */
const ABSENT = crypto.randomUUID();
/** `builtin_agents: { my_kortix: false }`. */
const OFF = crypto.randomUUID();
/** No key, and an error that voids the whole file (`sandbox: 42`): off. */
const BROKEN = crypto.randomUUID();
/** `my_kortix: true` and `sandbox: 42`: on, so My Kortix can fix the file. */
const BROKEN_ON = crypto.randomUUID();
/** Not YAML (a duplicate key): repair mode, only My Kortix runs. */
const SYNTAX = crypto.randomUUID();
/** A valid commit (My Kortix off), then one that is not YAML: the project runs the valid one. */
const LAST_GOOD = crypto.randomUUID();
/** No key, and the project still stores `experimental.meta_agent: true` from the removed flag. */
const LEGACY_ON = crypto.randomUUID();
const upstreams: LocalGitUpstream[] = [];
let lastGoodSeed = '';

/** Commit `content` to `path` on top of `repoUrl`'s main and push it. Returns the new commit's parent. */
function pushOnTop(repoUrl: string, path: string, content: string): { parent: string } {
  const work = join(repoUrl, '..', 'work');
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Kortix Test', '-c', 'user.email=test@kortix.invalid', ...args], { cwd: work }).toString().trim();
  const parent = git('rev-parse', 'HEAD');
  writeFileSync(join(work, path), content);
  git('commit', '-q', '-am', 'not YAML');
  git('push', '-q', repoUrl, 'main');
  return { parent };
}
const secrets: Record<string, string> = {};

beforeAll(async () => {
  const on = createLocalGitUpstream('builtin-agents-on', { 'kortix.yaml': manifest('builtin_agents:\n  my_kortix: true\n') });
  const onDefault = createLocalGitUpstream('builtin-agents-on-default', {
    'kortix.yaml': manifest('builtin_agents:\n  my_kortix: true\n', 'mykortix'),
  });
  const absent = createLocalGitUpstream('builtin-agents-absent', { 'kortix.yaml': manifest('') });
  const off = createLocalGitUpstream('builtin-agents-off', {
    'kortix.yaml': manifest('builtin_agents:\n  my_kortix: false\n'),
  });
  const broken = createLocalGitUpstream('builtin-agents-broken', { 'kortix.yaml': manifest('sandbox: 42\n') });
  const brokenOn = createLocalGitUpstream('builtin-agents-broken-on', {
    'kortix.yaml': manifest('sandbox: 42\nbuiltin_agents:\n  my_kortix: true\n'),
  });
  // The 2026-11-03 shape: an agent declared an app a platform write had already stubbed.
  const syntax = createLocalGitUpstream('builtin-agents-syntax', {
    'kortix.yaml': `${manifest('')}apps:\n  site:\n    always_on: true\n  site:\n    always_on: false\n`,
  });
  const lastGood = createLocalGitUpstream('builtin-agents-last-good', { 'kortix.yaml': manifest('') });
  const lastGoodCommit = pushOnTop(lastGood.repoUrl, 'kortix.yaml', `${manifest('')}apps:\n  site:\n    always_on: true\n  site:\n    always_on: false\n`);
  lastGoodSeed = lastGoodCommit.parent;
  upstreams.push(on, onDefault, absent, off, broken, brokenOn, syntax, lastGood);
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'builtin-agents-test' });
  await insertIntoView(db, accountMembers, [{ userId: OWNER, accountId: ACCOUNT, accountRole: 'owner', isSuperAdmin: false }]);
  for (const [projectId, repoUrl, metadata] of [
    [ON, on.repoUrl, {}],
    [ON_DEFAULT, onDefault.repoUrl, {}],
    [ABSENT, absent.repoUrl, {}],
    [OFF, off.repoUrl, {}],
    [BROKEN, broken.repoUrl, {}],
    [BROKEN_ON, brokenOn.repoUrl, {}],
    [SYNTAX, syntax.repoUrl, {}],
    [LAST_GOOD, lastGood.repoUrl, {}],
    [LEGACY_ON, absent.repoUrl, { experimental: { meta_agent: true } }],
  ] as const) {
    await db.insert(projects).values({ splitPending: true, projectId, accountId: ACCOUNT, name: `builtin-agents-${projectId.slice(0, 8)}`, repoUrl, metadata });
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

describe('builtin_agents.my_kortix: true (on)', () => {
  test('GET /detail lists My Kortix first and keeps the manifest default agent', async () => {
    const config = await detail(ON);
    expect(config.builtin_agents).toEqual({ my_kortix: true });
    expect(config.default_agent).toBe('kortix');
    expect(config.agents.map((agent) => agent.name)).toEqual(['mykortix', 'kortix']);
    expect(config.agents[0]).toMatchObject({ platform: true });
    expect(config.agents[0]?.description).toContain('The one agent you talk to');
  });

  test('`default_agent: mykortix` makes My Kortix the default, like any declared agent', async () => {
    const config = await detail(ON_DEFAULT);
    expect(config.builtin_agents).toEqual({ my_kortix: true });
    expect(config.default_agent).toBe('mykortix');
    expect(config.agents.map((agent) => agent.name)).toEqual(['mykortix', 'kortix']);
  });

  test('GET /agents/mykortix/config, and the old /agents/meta/config, answer the read-only built-in view, not 404', async () => {
    const legacy = await call(ON, '/agents/meta/config');
    expect(legacy.status).toBe(200);
    expect(await legacy.json()).toMatchObject({ agent: 'mykortix', builtin: 'my_kortix', editable: false });
    const res = await call(ON, '/agents/mykortix/config');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      agent: 'mykortix',
      builtin: 'my_kortix',
      editable: false,
      block: null,
      schema_version: 3,
      default_agent: 'kortix',
    });
  });

  test('a write to the built-in agent is refused with builtin_agent_managed, and nothing commits', async () => {
    const config = await call(ON, '/agents/mykortix/config', { method: 'PUT', body: JSON.stringify({ connectors: 'all' }) });
    expect(config.status).toBe(409);
    expect(await config.json()).toMatchObject({ code: 'builtin_agent_managed' });
    const scope = await call(ON, '/agents/meta/scope', { method: 'PUT', body: JSON.stringify({ connectors: 'all' }) });
    expect(scope.status).toBe(409);
    expect(await scope.json()).toMatchObject({ code: 'builtin_agent_managed' });
    expect((await detail(ON)).agents.map((agent) => agent.name)).toEqual(['mykortix', 'kortix']);
  });

  test('an undeclared agent still answers 404 agent_not_found', async () => {
    const res = await call(ON, '/agents/ghost/config');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'agent_not_found' });
  });
});

for (const [label, projectId] of [
  ['no builtin_agents key (off)', () => ABSENT],
  ['builtin_agents.my_kortix: false (off)', () => OFF],
  ['no builtin_agents key, a stored `meta_agent: true` from the removed flag (inert: off)', () => LEGACY_ON],
] as const) {
  describe(label, () => {
    test('GET /detail lists only the declared agents and keeps the manifest default', async () => {
      const config = await detail(projectId());
      expect(config.builtin_agents).toEqual({ my_kortix: false });
      expect(config.default_agent).toBe('kortix');
      expect(config.agents.map((agent) => agent.name)).toEqual(['kortix']);
    });

    test('`mykortix` and `meta` then have no config view', async () => {
      for (const name of ['mykortix', 'meta']) {
        const res = await call(projectId(), `/agents/${name}/config`);
        expect(res.status).toBe(404);
        expect(await res.json()).toMatchObject({ code: 'agent_not_found' });
      }
    });

    test('POST /sessions naming My Kortix is refused with 409 builtin_agent_disabled, and no session row is written', async () => {
      for (const name of ['mykortix', 'meta']) {
        const res = await call(projectId(), '/sessions', { method: 'POST', body: JSON.stringify({ agent_name: name }) });
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ code: 'builtin_agent_disabled' });
      }
      expect(await db.select().from(projectSessions).where(eq(projectSessions.projectId, projectId()))).toEqual([]);
    });
  });
}

describe('a file with an error that voids every key', () => {
  test('without the key: My Kortix is off, and naming it is refused with 409', async () => {
    const config = await detail(BROKEN);
    expect(config.builtin_agents).toEqual({ my_kortix: false });
    expect(config.agents.map((agent) => agent.name)).not.toContain('mykortix');
    const res = await call(BROKEN, '/sessions', { method: 'POST', body: JSON.stringify({ agent_name: 'mykortix' }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'builtin_agent_disabled' });
  });

  test('with `my_kortix: true`: My Kortix stays on and is the default, so that it can fix the file', async () => {
    const config = await detail(BROKEN_ON);
    expect(config.builtin_agents).toEqual({ my_kortix: true });
    expect(config.default_agent).toBe('mykortix');
    expect(config.agents[0]?.name).toBe('mykortix');
  });
});

describe('a file that is not YAML (repair mode)', () => {
  test('GET /detail names the syntax error and lists My Kortix, on, so that it can fix the file', async () => {
    const res = await call(SYNTAX, '/detail');
    expect(res.status).toBe(200);
    const config = ((await res.json()) as Detail & { config: { manifest_health: { issues: Array<{ path: string; line?: number }> } } }).config;
    expect(config.builtin_agents).toEqual({ my_kortix: true });
    expect(config.agents.map((agent) => agent.name)).toEqual(['mykortix']);
    expect(config.manifest_health.issues).toEqual([
      expect.objectContaining({ path: '<yaml>', line: 9, message: expect.stringContaining('Map keys must be unique') }),
    ]);
  });

  test('GET /agents/mykortix/config answers the built-in view; a project agent answers 409 manifest_invalid', async () => {
    const builtin = await call(SYNTAX, '/agents/mykortix/config');
    expect(builtin.status).toBe(200);
    expect(await builtin.json()).toMatchObject({ agent: 'mykortix', builtin: 'my_kortix', editable: false });
    const project = await call(SYNTAX, '/agents/kortix/config');
    expect(project.status).toBe(409);
    expect(await project.json()).toMatchObject({ code: 'manifest_invalid', error: expect.stringContaining('Map keys must be unique') });
  });

  test('POST /sessions for a project agent is 409 manifest_invalid, never 500, and writes no session row', async () => {
    const res = await call(SYNTAX, '/sessions', { method: 'POST', body: JSON.stringify({ agent_name: 'kortix' }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'manifest_invalid', error: 'kortix.yaml is not valid YAML (Map keys must be unique at line 9, column 3). Only My Kortix runs until it is fixed.' });
    expect(await db.select().from(projectSessions).where(eq(projectSessions.projectId, SYNTAX))).toEqual([]);
  });

  test('POST /sessions for My Kortix passes agent resolution exactly like a project that runs My Kortix', async () => {
    // This suite has no sandbox provider: both creates stop at the same later
    // step. The point is that the file's syntax error is not what stops them.
    const create = (projectId: string) =>
      call(projectId, '/sessions', { method: 'POST', body: JSON.stringify({ agent_name: 'mykortix' }) });
    const repair = await create(SYNTAX);
    const healthy = await create(ON);
    const repairBody = (await repair.json()) as { code?: string };
    expect(repairBody.code).not.toBe('manifest_invalid');
    expect(repairBody.code).not.toBe('builtin_agent_disabled');
    expect(repair.status).not.toBe(500);
    expect({ status: repair.status, code: repairBody.code }).toEqual({
      status: healthy.status,
      code: ((await healthy.json()) as { code?: string }).code,
    });
  });
});

describe('a file that is not YAML, with a valid commit before it (last good version)', () => {
  test('GET /detail runs the last valid commit: its agents and its My Kortix switch, and the issue names that commit', async () => {
    const res = await call(LAST_GOOD, '/detail');
    expect(res.status).toBe(200);
    const config = ((await res.json()) as Detail & { config: { manifest_health: { issues: Array<{ path: string; message: string }> } } }).config;
    expect(config.builtin_agents).toEqual({ my_kortix: false });
    expect(config.default_agent).toBe('kortix');
    expect(config.agents.map((agent) => agent.name)).toEqual(['kortix']);
    expect(config.manifest_health.issues).toEqual([
      expect.objectContaining({
        path: '<yaml>',
        message: `Syntax error: Map keys must be unique at line 9, column 3. Kortix keeps running this file as of commit ${lastGoodSeed.slice(0, 7)}, the last version that parses, until it is fixed. Edits from Kortix are refused until then.`,
      }),
    ]);
  });

  test('GET /agents/kortix/config reads the running agent; a write is 409 manifest_invalid and commits nothing', async () => {
    const read = await call(LAST_GOOD, '/agents/kortix/config');
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ agent: 'kortix', editable: true });
    const write = await call(LAST_GOOD, '/default-agent', { method: 'PUT', body: JSON.stringify({ agent: 'kortix' }) });
    expect(write.status).toBe(409);
    expect(await write.json()).toEqual({
      code: 'manifest_invalid',
      error: 'kortix.yaml on the default branch is not valid YAML (Map keys must be unique at line 9, column 3). Kortix does not change it until it is fixed.',
    });
  });

  test('POST /sessions for the project agent passes agent resolution; My Kortix stays off, as the valid commit says', async () => {
    const create = (projectId: string, agent: string) =>
      call(projectId, '/sessions', { method: 'POST', body: JSON.stringify({ agent_name: agent }) });
    const lastGoodRes = await create(LAST_GOOD, 'kortix');
    const healthy = await create(ON, 'kortix');
    expect({ status: lastGoodRes.status, code: ((await lastGoodRes.json()) as { code?: string }).code }).toEqual({
      status: healthy.status,
      code: ((await healthy.json()) as { code?: string }).code,
    });
    const myKortix = await create(LAST_GOOD, 'mykortix');
    expect(myKortix.status).toBe(409);
    expect(await myKortix.json()).toMatchObject({ code: 'builtin_agent_disabled' });
  });
});
