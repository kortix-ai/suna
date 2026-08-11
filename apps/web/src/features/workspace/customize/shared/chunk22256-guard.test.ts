import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

// Regression test for the Better Stack chunk-22256 cluster:
//   5af76e2b… / c80ef19c… / bb2da889… —
//     `(intermediate value)(intermediate value)(intermediate value).filter is not a function`
//   7ef0c059… — `Cannot read properties of undefined (reading 'map')`
//
// All four are `.filter` / `.map` called on a `WorkspaceConfigSummary` array
// field (`agents` / `skills` / `commands`) that the API can return as
// `undefined` (or a non-array) for repo-less / capability-gated / config-build
// failure states. The fix guards every such call site with `toArray(...)` so a
// missing/non-array field can never throw into prod Sentry. These source-level
// assertions keep a future refactor from silently restoring the unguarded
// `.filter` / `.map` (the connectors-view Slack test uses the same pattern).

// The agents surface moved from this overlay section to the standalone
// `/projects/[id]/agent` page; the guard follows the code, because the config
// fields it reads (and the ways they can come back undefined) did not change.
const capabilities = join(
  import.meta.dir,
  '..',
  '..',
  'capabilities',
  'agents',
);
const agentsPage = readFileSync(join(capabilities, 'agents-page.tsx'), 'utf8');
const agentDetailAside = readFileSync(join(capabilities, 'agent-detail-aside.tsx'), 'utf8');
const configEntityView = readFileSync(
  join(import.meta.dir, '..', 'sections', 'component', 'config-entity-view.tsx'),
  'utf8',
);

describe('chunk-22256 .filter/.map guard regression', () => {
  test('the agent aside does not call config.skills.map unguarded', () => {
    expect(agentDetailAside).not.toContain('config.skills.map(');
    expect(agentDetailAside).toContain('toArray(config.skills).map(');
  });

  test('the agents page does not call config.agents.filter unguarded', () => {
    // Both consumers: the default-agent selector's `.filter`, and the page's
    // own `agents` memo, which `filterAgents` then calls `.filter` on.
    expect(agentsPage).not.toContain('config.agents.filter(');
    expect(agentsPage).toContain('toArray(config.agents).filter(');
    expect(agentsPage).toContain('toArray(config?.agents)');
  });

  test('config-entity-view guards select(config) before any .filter consumer', () => {
    // The `entities` array (consumed by `entities.filter`) comes from
    // `select(config)` = one of config.agents/skills/commands; must be coerced.
    expect(configEntityView).not.toMatch(/\(config \? select\(config\) : \[\]\)/);
    expect(configEntityView).toContain('toArray(select(config))');
  });
});
