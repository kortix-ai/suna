import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

// Regression test for the Better Stack chunk-22256 cluster:
//   5af76e2b… / c80ef19c… / bb2da889… —
//     `(intermediate value)(intermediate value)(intermediate value).filter is not a function`
//   7ef0c059… — `Cannot read properties of undefined (reading 'map')`
//
// All four are `.filter` / `.map` called on a `ProjectConfigSummary` array
// field (`agents` / `skills` / `commands`) that the API can return as
// `undefined` (or a non-array) for repo-less / capability-gated / config-build
// failure states. The fix guards every such call site with `toArray(...)` so a
// missing/non-array field can never throw into prod Sentry. These source-level
// assertions keep a future refactor from silently restoring the unguarded
// `.filter` / `.map` (the connectors-view Slack test uses the same pattern).

const agentsView = readFileSync(
  join(import.meta.dir, '..', 'sections', 'view', 'agents-view.tsx'),
  'utf8',
);
const configEntityView = readFileSync(
  join(import.meta.dir, '..', 'sections', 'component', 'config-entity-view.tsx'),
  'utf8',
);

describe('chunk-22256 .filter/.map guard regression', () => {
  test('agents-view no longer calls config.skills.map unguarded', () => {
    expect(agentsView).not.toContain('config.skills.map(');
    expect(agentsView).toContain('toArray(config.skills).map(');
  });

  test('agents-view no longer calls config.agents.filter unguarded', () => {
    expect(agentsView).not.toContain('config.agents.filter(');
    expect(agentsView).toContain('toArray(config.agents).filter(');
  });

  test('config-entity-view guards select(config) before any .filter consumer', () => {
    // The `entities` array (consumed by `entities.filter`) comes from
    // `select(config)` = one of config.agents/skills/commands; must be coerced.
    expect(configEntityView).not.toMatch(/\(config \? select\(config\) : \[\]\)/);
    expect(configEntityView).toContain('toArray(select(config))');
  });
});
