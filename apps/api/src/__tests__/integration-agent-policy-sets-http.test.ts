/**
 * An agent's `policy_sets` through the two agent write routes, in-process app,
 * real DB, real git:
 * - PUT /agents/:name/config with `policy_sets: {}` removes the key (the agent
 *   editor sends `{}` when the last set goes back to the base rules; an omitted
 *   key keeps the declared value).
 * - PUT /agents/:name/scope that un-grants a connector keeps its set entry, so
 *   re-granting it brings the set back. Pruning the entry let a writer without
 *   project.connector.write move the agent onto the base rules in two writes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { eq, sql } from 'drizzle-orm';
import { parse as parseYaml } from 'yaml';
import { accountMembers, accounts, projectMembers, projects } from '@kortix/db';
import { db } from '../shared/db';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';
import { insertIntoView } from './helpers/compat-views';
import { createLocalGitUpstream, type LocalGitUpstream } from './helpers/local-git-upstream';

const MANIFEST = `default_agent: support
project:
  name: agent-policy-sets
agents:
  support:
    connectors: [qa-mail, qa-pay]
    policy_sets:
      qa-mail: read_only
connectors:
  - slug: qa-mail
    provider: mcp
    url: http://127.0.0.1:9/mcp
    policy_sets:
      read_only:
        policies:
          - match: send_*
            action: block
  - slug: qa-pay
    provider: mcp
    url: http://127.0.0.1:9/pay
`;

const ACCOUNT = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
let upstream: LocalGitUpstream;
let secret = '';

beforeAll(async () => {
  // The scope route commits with the git CLI to the local bare upstream, no token.
  process.env.KORTIX_LOCAL_DEV = '1';
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'agent-policy-sets-test' });
  await insertIntoView(db, accountMembers, [{ userId: OWNER, accountId: ACCOUNT, accountRole: 'owner', isSuperAdmin: false }]);
  upstream = createLocalGitUpstream('agent-policy-sets', { 'kortix.yaml': MANIFEST });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'agent-policy-sets',
    repoUrl: upstream.repoUrl,
  });
  await insertIntoView(db, projectMembers, [
    { accountId: ACCOUNT, projectId: PROJECT, userId: OWNER, projectRole: 'manager' },
  ]);
  secret = (
    await createAccountToken({
      accountId: ACCOUNT,
      userId: OWNER,
      projectId: PROJECT,
      name: 'agent-policy-sets',
      agentGrant: null as any,
    })
  ).secretKey;
});

afterAll(async () => {
  await db.execute(sql`delete from kortix.account_tokens where account_id = ${ACCOUNT}`);
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  upstream.remove();
});

const committed = (): Record<string, any> =>
  parseYaml(execFileSync('git', ['--git-dir', upstream.repoUrl, 'show', 'main:kortix.yaml'], { encoding: 'utf8' }));

const call = (path: string, method = 'GET', body?: unknown) =>
  app.request(`/v1/projects/${PROJECT}/agents/support/${path}`, {
    method,
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('agent policy_sets through the agent write routes', () => {
  test('scope: un-granting a connector keeps its set; re-granting brings it back', async () => {
    const ungrant = await call('scope', 'PUT', { connectors: ['qa-pay'] });
    expect(ungrant.status).toBe(200);
    expect(committed().agents.support).toMatchObject({ connectors: ['qa-pay'], policy_sets: { 'qa-mail': 'read_only' } });

    const regrant = await call('scope', 'PUT', { connectors: ['qa-pay', 'qa-mail'] });
    expect(regrant.status).toBe(200);
    expect(((await regrant.json()) as { policy_sets: Record<string, string> }).policy_sets).toEqual({ 'qa-mail': 'read_only' });
    expect(committed().agents.support.policy_sets).toEqual({ 'qa-mail': 'read_only' });
  });

  {
    test('config: policy_sets {} removes the key; an omitted key keeps it', async () => {
      const read = await call('config');
      expect(read.status).toBe(200);
      const { block } = (await read.json()) as { block: Record<string, unknown> };
      expect(block.policy_sets).toEqual({ 'qa-mail': 'read_only' });

      const { policy_sets: _sets, ...withoutSets } = block;
      const kept = await call('config', 'PUT', withoutSets);
      expect(kept.status).toBe(200);
      expect(committed().agents.support.policy_sets).toEqual({ 'qa-mail': 'read_only' });

      const cleared = await call('config', 'PUT', { ...withoutSets, policy_sets: {} });
      expect(cleared.status).toBe(200);
      expect('policy_sets' in committed().agents.support).toBe(false);
    });
  }
});
