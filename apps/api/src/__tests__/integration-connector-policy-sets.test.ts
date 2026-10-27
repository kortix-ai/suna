/**
 * Connector policy sets against real Postgres and a real git upstream:
 * kortix.yaml on main → sync → `connector_policy_sets` rows, which the gateway
 * reads. Pins the rollout-safety property (the base-rule readers never see a
 * set), fail closed on a missing set, the 409 for a set in use, rename in one
 * commit, and that conditions survive a rule write.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, connectorPolicySets, connectors, projects } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { parse as parseYaml } from 'yaml';

import { dbConnectorRouterDeps } from '../connectors/db-deps';
import { loadConnectorPoliciesFor, loadConnectorPolicySetFor } from '../connectors/db-deps-rows';
import {
  deleteConnectorPolicySetInManifest,
  getConnectorPoliciesFromManifest,
  renameConnectorPolicySetInManifest,
  setConnectorPoliciesInManifest,
  upsertConnectorPolicySetInManifest,
} from '../connectors/manifest-crud';
import { syncProjectConnectors } from '../connectors/sync';
import { db } from '../shared/db';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const SLUG = 'qa-mail';
let remote = '';
let work = '';

const MANIFEST = `kortix_version: 2
default_agent: support
agents:
  support:
    connectors: [${SLUG}]
    policy_sets:
      ${SLUG}: read_only
  sales:
    connectors: [${SLUG}]
    policy_sets:
      ${SLUG}: outreach
connectors:
  - slug: ${SLUG}
    provider: mcp
    url: http://127.0.0.1:9/mcp
    policies:
      - match: delete_*
        action: block
      - match: send_email
        action: require_approval
        conditions:
          - arg: to
            match: "*@example.com"
    policy_sets:
      read_only:
        description: Read and search, never send
        policies:
          - match: send_*
            action: block
      outreach:
        policies:
          - match: send_email
            action: always_run
      empty: {}
`;

function upstreamManifest(): Record<string, any> {
  execFileSync('git', ['pull', '-q', 'origin', 'main'], { cwd: work });
  return parseYaml(execFileSync('git', ['show', 'HEAD:kortix.yaml'], { cwd: work, encoding: 'utf8' }));
}

async function connectorId(): Promise<string> {
  const [row] = await db
    .select({ connectorId: connectors.connectorId })
    .from(connectors)
    .where(and(eq(connectors.projectId, PROJECT), eq(connectors.slug, SLUG)))
    .limit(1);
  return row!.connectorId;
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error('policy-sets: DATABASE_URL is required (local Postgres)');
  // Writes commit to the local bare upstream with the git CLI, no token.
  process.env.KORTIX_LOCAL_DEV = '1';
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'policy-sets' });
  const root = mkdtempSync(join(tmpdir(), 'kortix-policy-sets-'));
  remote = join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { cwd: root });
  work = join(root, 'work');
  execFileSync('git', ['clone', '-q', remote, work], { cwd: root });
  writeFileSync(join(work, 'kortix.yaml'), MANIFEST);
  execFileSync('git', ['add', '-A'], { cwd: work });
  execFileSync('git', ['-c', 'user.name=Kortix Test', '-c', 'user.email=test@kortix.test', 'commit', '-q', '-m', 'sets'], { cwd: work });
  execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: work });
  await db.insert(projects).values({ projectId: PROJECT, accountId: ACCOUNT, name: 'policy-sets', repoUrl: remote });
});

afterAll(async () => {
  await db.delete(connectors).where(eq(connectors.projectId, PROJECT));
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('connector policy sets', () => {
  test('sync materializes one row per set; the base-rule readers never see a set rule', async () => {
    await syncProjectConnectors(PROJECT, ACCOUNT);
    const id = await connectorId();
    // Rollout safety: what API code that predates sets reads.
    expect((await loadConnectorPoliciesFor(id)).map((p) => p.match)).toEqual(['delete_*', 'send_email']);
    const rows = await db.select().from(connectorPolicySets).where(eq(connectorPolicySets.connectorId, id));
    expect(rows.map((r) => r.name).sort()).toEqual(['empty', 'outreach', 'read_only']);
    expect(rows.find((r) => r.name === 'read_only')!.description).toBe('Read and search, never send');
    expect(await loadConnectorPolicySetFor(id, 'read_only')).toEqual([
      { match: 'send_*', action: 'block', position: 0, conditions: null },
    ]);
    // An empty set exists (rules []); an unknown set is missing (null → block).
    expect(await loadConnectorPolicySetFor(id, 'empty')).toEqual([]);
    expect(await loadConnectorPolicySetFor(id, 'nope')).toBeNull();
  });

  test('the effective view resolves as an agent holding the set would', async () => {
    const view = await dbConnectorRouterDeps.getConnectorPolicies!(PROJECT, SLUG, 'read_only');
    expect(view && 'policy_set' in view ? view.policy_set : null).toBe('read_only');
    const missing = await dbConnectorRouterDeps.getConnectorPolicies!(PROJECT, SLUG, 'nope');
    expect(missing).toMatchObject({ code: 'policy_set_not_found' });
  });

  test('deleting a set an agent uses is refused with 409, naming the agents', async () => {
    const result = await deleteConnectorPolicySetInManifest(PROJECT, ACCOUNT, SLUG, 'read_only');
    expect(result).toMatchObject({ ok: false, status: 409, body: { code: 'policy_set_in_use', agents: ['support'] } });
  });

  test('set rules write through kortix.yaml with conditions; the base conditions survive a base write', async () => {
    const rules = [
      { match: 'send_email', action: 'require_approval' as const, conditions: [{ arg: 'to', match: '*@example.com' }] },
      { match: 'send_*', action: 'block' as const },
    ];
    expect((await setConnectorPoliciesInManifest(PROJECT, ACCOUNT, SLUG, rules, 'read_only')).ok).toBe(true);
    const yaml = upstreamManifest();
    expect(yaml.connectors[0].policy_sets.read_only.policies).toEqual(rules);
    expect((await loadConnectorPolicySetFor(await connectorId(), 'read_only'))![0]!.conditions).toEqual([
      { arg: 'to', match: '*@example.com' },
    ]);

    // A UI toggle: read the base rules, PUT them back. The conditional rule stays conditional.
    const base = await getConnectorPoliciesFromManifest(PROJECT, SLUG);
    expect((await setConnectorPoliciesInManifest(PROJECT, ACCOUNT, SLUG, base!.policies)).ok).toBe(true);
    expect(upstreamManifest().connectors[0].policies[1].conditions).toEqual([{ arg: 'to', match: '*@example.com' }]);
    expect((await setConnectorPoliciesInManifest(PROJECT, ACCOUNT, SLUG, rules, 'nope'))).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  test('rename rewrites every agent reference in the same commit', async () => {
    const result = await renameConnectorPolicySetInManifest(PROJECT, ACCOUNT, SLUG, 'read_only', 'quiet');
    expect(result.ok).toBe(true);
    const yaml = upstreamManifest();
    expect(Object.keys(yaml.connectors[0].policy_sets)).toEqual(['quiet', 'outreach', 'empty']);
    expect(yaml.agents.support.policy_sets).toEqual({ [SLUG]: 'quiet' });
    expect(await loadConnectorPolicySetFor(await connectorId(), 'quiet')).not.toBeNull();
    expect(await loadConnectorPolicySetFor(await connectorId(), 'read_only')).toBeNull();
    expect(await renameConnectorPolicySetInManifest(PROJECT, ACCOUNT, SLUG, 'quiet', 'outreach')).toMatchObject({
      ok: false,
      status: 409,
      body: { code: 'policy_set_exists' },
    });
    expect(await renameConnectorPolicySetInManifest(PROJECT, ACCOUNT, SLUG, 'quiet', 'base')).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  test('create, describe, list and delete an unused set', async () => {
    expect(await upsertConnectorPolicySetInManifest(PROJECT, ACCOUNT, SLUG, 'triage', 'Label only')).toMatchObject({
      ok: true,
      created: true,
    });
    const listed = await dbConnectorRouterDeps.listConnectorPolicySets!(PROJECT, SLUG);
    expect(listed!.sets.map((s) => [s.name, s.agents])).toEqual([
      ['empty', []],
      ['outreach', ['sales']],
      ['quiet', ['support']],
      ['triage', []],
    ]);
    expect(listed!.sets.find((s) => s.name === 'triage')!.description).toBe('Label only');
    expect((await deleteConnectorPolicySetInManifest(PROJECT, ACCOUNT, SLUG, 'empty')).ok).toBe(true);
    expect(await loadConnectorPolicySetFor(await connectorId(), 'empty')).toBeNull();
    expect(Object.keys(upstreamManifest().connectors[0].policy_sets)).not.toContain('empty');
  });
});
