/**
 * `policy ls` must reflect a rule `policy <slug> set` just wrote (KRTX-2527).
 *
 * On dev, `policy dogfood-mcp set '*' ask` succeeded and persisted to the
 * project's kortix.yaml on main, yet the parent `policy ls` still printed
 * "No explicit project policies" — per-connector rules were only visible to
 * `policy <slug> ls`. A customer setting their first rule sees an empty
 * policy view and can believe the set failed.
 *
 * The parent view now carries per-connector rule counts from the same
 * manifest read (`connectorRules`), so the CLI can list them.
 *
 * Real-Postgres tenant contract — run with DATABASE_URL pointed at an
 * isolated migrated database (mirrors
 * integration-connector-sync-count-agrees-with-list.test.ts).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { connectors, projects, accounts } from '@kortix/db';
import { eq } from 'drizzle-orm';

import { getProjectPoliciesFromManifest } from '../connectors/manifest-crud';
import { db } from '../shared/db';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();

beforeAll(async () => {
  if (!process.env.DATABASE_URL)
    throw new Error('policy-ls: DATABASE_URL is required (local Postgres)');
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'policy-ls-shows-rules' });

  // A real bare upstream on disk; the API's mirror clones it over file://
  // (same pattern as integration-project-snapshot.test.ts). One connector
  // with a tool-call rule, one without — the parent view lists only the
  // former, with its rule count.
  const root = mkdtempSync(join(tmpdir(), 'kortix-policy-ls-'));
  const remote = join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { cwd: root });
  const work = join(root, 'work');
  execFileSync('git', ['clone', '-q', remote, work], { cwd: root });
  writeFileSync(
    join(work, 'kortix.yaml'),
    [
      'kortix_version: 2',
      'connectors:',
      '  - slug: qa-mcp',
      '    provider: mcp',
      '    url: http://127.0.0.1:9/mcp',
      '    policies:',
      '      - match: "*"',
      '        action: require_approval',
      '  - slug: qa-open',
      '    provider: mcp',
      '    url: http://127.0.0.1:9/open',
      '',
    ].join('\n'),
  );
  execFileSync('git', ['add', '-A'], { cwd: work });
  execFileSync('git', ['commit', '-q', '-m', 'declare connectors + one rule'], { cwd: work });
  execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: work });

  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'policy-ls-shows-rules',
    repoUrl: remote,
  });
});

afterAll(async () => {
  await db.delete(connectors).where(eq(connectors.projectId, PROJECT));
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('getProjectPoliciesFromManifest — per-connector rule counts', () => {
  test('the parent policy view lists the connector rules set in the manifest', async () => {
    const view = await getProjectPoliciesFromManifest(PROJECT);
    expect(view).not.toBeNull();
    expect(view!.policies).toEqual([]);
    expect(view!.defaultMode).toBe('allow_all');
    expect(view!.connectorRules).toEqual([{ slug: 'qa-mcp', count: 1 }]);
  });
});
