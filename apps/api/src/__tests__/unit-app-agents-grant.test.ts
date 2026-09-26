import { describe, expect, test } from 'bun:test';

import { agentsGrantingApp } from '../apps/routes';

describe('agentsGrantingApp — kortix.yaml agents.<name>.apps', () => {
  const agents = {
    'report-writer': { apps: ['reports-dashboard'] },
    ops: { apps: 'all' },
    reviewer: { apps: 'none' },
    writer: { apps: ['other-app'] },
    legacy: { kortix_permissions: ['project.read'] },
    shouty: { apps: ['REPORTS-DASHBOARD'] },
  };

  test('lists `all` and slug grants, sorted by name, with the declaring path', () => {
    expect(agentsGrantingApp(agents, 'reports-dashboard', 'kortix.yaml')).toEqual([
      { agent_name: 'ops', grant: 'all', path: 'kortix.yaml#agents.ops' },
      { agent_name: 'report-writer', grant: 'listed', path: 'kortix.yaml#agents.report-writer' },
      { agent_name: 'shouty', grant: 'listed', path: 'kortix.yaml#agents.shouty' },
    ]);
  });

  test('uses the imported file an agent is declared in', () => {
    expect(
      agentsGrantingApp({ ops: { apps: 'all' } }, 'x', 'kortix.yaml', { ops: 'agents/ops.yaml' }),
    ).toEqual([{ agent_name: 'ops', grant: 'all', path: 'agents/ops.yaml#agents.ops' }]);
  });

  test('a v1 array, a scalar, or no agents map grants nothing', () => {
    expect(agentsGrantingApp([{ name: 'a', apps: 'all' }], 'x', 'kortix.toml')).toEqual([]);
    expect(agentsGrantingApp('all', 'x', 'kortix.yaml')).toEqual([]);
    expect(agentsGrantingApp(undefined, 'x', 'kortix.yaml')).toEqual([]);
  });
});
