/**
 * GET /v1/projects/:id/agents/:name/capabilities, and the `{ exclude }` grant
 * the agent page writes from it. In-process app, real DB, real git.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { KORTIX_SKILL_NAMES } from '@kortix/manifest-schema';
import { accountMembers, accounts, projectMembers, projects } from '@kortix/db';
import { db } from '../shared/db';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';
import { insertIntoView } from './helpers/compat-views';
import { createLocalGitUpstream, type LocalGitUpstream } from './helpers/local-git-upstream';

const MANIFEST = `kortix_version: 3
default_agent: kortix
skills:
  pdf: skills/pdf
tools:
  lookup_order: tools/lookup_order.ts
extensions:
  web:
    pi: npm:pi-web-access@0.30.0
agents:
  kortix:
    prompt: You do the work.
    skills: all
    extensions: all
`;

const ACCOUNT = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
let secret = '';
let upstream: LocalGitUpstream;

beforeAll(async () => {
  upstream = createLocalGitUpstream('agent-capabilities', {
    'kortix.yaml': MANIFEST,
    'skills/pdf/SKILL.md': '---\nname: pdf\ndescription: Make PDF files.\n---\nBody.\n',
    'tools/lookup_order.ts': 'export default {}\n',
  });
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'agent-capabilities-test' });
  await insertIntoView(db, accountMembers, [{ userId: OWNER, accountId: ACCOUNT, accountRole: 'owner', isSuperAdmin: false }]);
  await db.insert(projects).values({ projectId: PROJECT, accountId: ACCOUNT, name: 'agent-capabilities', repoUrl: upstream.repoUrl, metadata: {} });
  await insertIntoView(db, projectMembers, [{ accountId: ACCOUNT, projectId: PROJECT, userId: OWNER, projectRole: 'manager' }]);
  secret = (await createAccountToken({ accountId: ACCOUNT, userId: OWNER, projectId: PROJECT, name: 'agent-capabilities-test', agentGrant: null as any })).secretKey;
});

afterAll(async () => {
  await db.execute(sql`delete from kortix.account_tokens where account_id = ${ACCOUNT}`);
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  upstream.remove();
});

const call = (path: string, init: RequestInit = {}) =>
  app.request(`/v1/projects/${PROJECT}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', ...init.headers },
  });

interface Catalog {
  agent: string;
  tools: Array<{ id: string; group: string; source: string | null; aliases: string[] }>;
  skills: Array<{ id: string; group: string; description: string | null; feature_flag: string | null; available: boolean }>;
  extensions: Array<{ id: string; group: string; required: boolean; controlled_by: string | null }>;
}

describe('GET /agents/:name/capabilities', () => {
  test('lists the built-in and project tools, skills and extensions', async () => {
    const res = await call('/agents/kortix/capabilities');
    expect(res.status).toBe(200);
    const catalog = (await res.json()) as Catalog;
    expect(catalog.agent).toBe('kortix');
    expect(catalog.tools.find((tool) => tool.id === 'agent')).toMatchObject({ group: 'interaction', aliases: ['task'] });
    expect(catalog.tools.find((tool) => tool.id === 'lookup_order')).toMatchObject({ group: 'project', source: 'tools/lookup_order.ts' });
    expect(catalog.skills.find((skill) => skill.id === 'pdf')).toEqual({ id: 'pdf', group: 'project', description: 'Make PDF files.', feature_flag: null, available: true });
    for (const name of KORTIX_SKILL_NAMES) expect(catalog.skills.find((skill) => skill.id === name)?.group).toBe('builtin');
    expect(catalog.skills.find((skill) => skill.id === 'kortix-goals')).toMatchObject({ feature_flag: 'goals', available: false });
    expect(catalog.skills.find((skill) => skill.id === 'kortix-system')?.description).toBeTruthy();
    expect(catalog.extensions.filter((ext) => ext.required).map((ext) => ext.id)).toEqual(['kortix-nested-calls', 'kortix-presentation', 'kortix-turn']);
    expect(catalog.extensions.find((ext) => ext.id === 'web')).toMatchObject({ group: 'project', required: false });
  });

  test('an undeclared agent answers 404 agent_not_found', async () => {
    const res = await call('/agents/ghost/capabilities');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'agent_not_found' });
  });

  test('no token answers 401', async () => {
    const res = await app.request(`/v1/projects/${PROJECT}/agents/kortix/capabilities`);
    expect(res.status).toBe(401);
  });
});

describe('PUT /agents/:name/config with { exclude }', () => {
  test('writes skills and extensions excludes to kortix.yaml and reads them back', async () => {
    const before = (await (await call('/agents/kortix/config')).json()) as { block: Record<string, unknown> };
    const { behavior, opencode: _opencode, ...governance } = before.block;
    const put = await call('/agents/kortix/config', {
      method: 'PUT',
      body: JSON.stringify({ ...governance, behavior, skills: { exclude: ['kortix-goals'] }, extensions: { exclude: ['web'] }, tools: { exclude: ['agent', 'task'] } }),
    });
    expect(put.status).toBe(200);
    const after = (await (await call('/agents/kortix/config')).json()) as { block: Record<string, unknown> };
    expect(after.block.skills).toEqual({ exclude: ['kortix-goals'] });
    expect(after.block.extensions).toEqual({ exclude: ['web'] });
    expect(after.block.tools).toEqual({ exclude: ['agent', 'task'] });
  });

  test('an exclude that names an unregistered skill is refused', async () => {
    const before = (await (await call('/agents/kortix/config')).json()) as { block: Record<string, unknown> };
    const { behavior, opencode: _opencode, ...governance } = before.block;
    const put = await call('/agents/kortix/config', { method: 'PUT', body: JSON.stringify({ ...governance, behavior, skills: { exclude: ['nope'] } }) });
    expect(put.status).toBe(400);
    expect(JSON.stringify(await put.json())).toContain('nope');
  });
});
