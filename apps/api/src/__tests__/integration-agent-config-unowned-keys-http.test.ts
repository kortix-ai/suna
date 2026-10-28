/**
 * KRTX-2990: a kortix_version 2 agent block can hold keys the strict
 * PUT /agents/:name/config schema cannot carry (`harnesses`,
 * `network_egress`). The v2 write replaces the whole block, so an edit that
 * omitted them — `kortix agents config --set`, any client — deleted them from
 * kortix.yaml. v3 already keeps them. In-process app, real DB, real git.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { eq, sql } from 'drizzle-orm';
import { accountMembers, accounts, projectMembers, projects } from '@kortix/db';
import { db } from '../shared/db';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';
import { insertIntoView } from './helpers/compat-views';
import { createLocalGitUpstream, type LocalGitUpstream } from './helpers/local-git-upstream';

const MANIFEST = `kortix_version: 2
default_agent: kortix
project:
  name: unowned-keys
agents:
  kortix:
    file: agents/kortix.md
    connectors: all
    harnesses:
      pi:
        codemode: only
    network_egress:
      version: 1
      default: deny
      rules: []
`;

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const OWNER = crypto.randomUUID();
let upstream: LocalGitUpstream;
let secret = '';

beforeAll(async () => {
  upstream = createLocalGitUpstream('agent-config-unowned-keys', { 'kortix.yaml': MANIFEST });
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'agent-config-unowned-keys-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'agent-config-unowned-keys-test-project',
    repoUrl: upstream.repoUrl,
  });
  await insertIntoView(db, accountMembers, [{ userId: OWNER, accountId: ACCOUNT, accountRole: 'owner', isSuperAdmin: false }]);
  await insertIntoView(db, projectMembers, [{ accountId: ACCOUNT, projectId: PROJECT, userId: OWNER, projectRole: 'manager' }]);
  secret = (
    await createAccountToken({ accountId: ACCOUNT, userId: OWNER, projectId: PROJECT, name: 'agent-config-unowned-keys-test', agentGrant: null as any })
  ).secretKey;
});

afterAll(async () => {
  await db.execute(sql`delete from kortix.account_tokens where account_id = ${ACCOUNT}`);
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  upstream.remove();
});

const configUrl = `/v1/projects/${PROJECT}/agents/kortix/config`;
const committedManifest = () =>
  execFileSync('git', ['--git-dir', upstream.repoUrl, 'show', 'main:kortix.yaml'], { encoding: 'utf8' });

describe('PUT /agents/:name/config on a kortix_version 2 manifest', () => {
  test('an edit that omits harnesses and network_egress keeps them in kortix.yaml', async () => {
    const read = await app.request(configUrl, { headers: { Authorization: `Bearer ${secret}` } });
    expect(read.status).toBe(200);
    const { block } = (await read.json()) as { block: Record<string, unknown> };
    expect(block).toMatchObject({ harnesses: { pi: { codemode: 'only' } }, network_egress: { default: 'deny' } });

    // What `kortix agents config kortix --set connectors=none` sends: the GET
    // block, without the keys the strict PUT schema refuses, plus the edit.
    const { harnesses: _h, network_egress: _n, ...writable } = block;
    const saved = await app.request(configUrl, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...writable, connectors: 'none' }),
    });
    expect(saved.status).toBe(200);

    const yaml = committedManifest();
    expect(yaml).toContain('codemode: only');
    expect(yaml).toContain('network_egress:');
    expect(yaml).not.toContain('connectors: all');
  });

  test('the agent page sends the GET block back unchanged, server-kept keys included: 200, both kept', async () => {
    const read = await app.request(configUrl, { headers: { Authorization: `Bearer ${secret}` } });
    const { block } = (await read.json()) as { block: Record<string, unknown> };
    // The web editor's draft is the GET block itself, plus the edit.
    const saved = await app.request(configUrl, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...block, connectors: 'all' }),
    });
    expect(saved.status).toBe(200);

    const yaml = committedManifest();
    expect(yaml).toContain('codemode: only');
    expect(yaml).toContain('network_egress:');
    expect(yaml).toContain('connectors: all');
  });
});
