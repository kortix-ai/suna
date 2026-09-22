/**
 * `apps` — the per-agent Kortix App grant (spec 2026-09-22
 * agents-as-principals §2.5). Additive, optional on both public wire types:
 * the file fails `tsc` if either field is missing, and a server released
 * before the field still type-checks (absent = none).
 */
import { describe, expect, test } from 'bun:test';
import type { AgentConfigBlock } from './agent-config';
import type { ProjectConfigSummary } from './projects';

type AgentScope = NonNullable<ProjectConfigSummary['agents'][number]['scope']>;

describe('apps on public wire types', () => {
  test('AgentConfigBlock accepts an App slug list, "all", and "none"', () => {
    const list: AgentConfigBlock = { kortix_permissions: ['project.app.read'], apps: ['reports-dashboard'] };
    const all: AgentConfigBlock = { apps: 'all' };
    const none: AgentConfigBlock = { apps: 'none' };
    expect([list.apps, all.apps, none.apps]).toEqual([['reports-dashboard'], 'all', 'none']);
  });

  test('ProjectConfigSummary agent scope mirrors apps, and a pre-field server omits it', () => {
    const current: AgentScope = { env: 'all', connectors: [], kortix_permissions: [], kortix_cli: [], apps: ['reports-dashboard'] };
    const older: AgentScope = { env: 'all', connectors: [], kortix_cli: [] };
    expect(current.apps).toEqual(['reports-dashboard']);
    expect(older.apps).toBeUndefined();
  });
});
