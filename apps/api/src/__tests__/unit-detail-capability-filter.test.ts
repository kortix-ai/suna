import { describe, test, expect } from 'bun:test';
import { applyDetailCapabilityFilter } from '../projects/lib/detail-capability-filter';
import { manifestHealthOf } from '../projects/lib/manifest-health';

// Record<string, unknown> so the filtered fields (which the runtime blanks to
// {} / [] / null) type as `unknown` at the assertions — otherwise the literal
// type (e.g. manifest: { name: string }) rejects `.toEqual({})`.
const sampleConfig: Record<string, unknown> = {
  is_kortix_repo: true,
  signals: { manifest: true },
  manifest_raw: 'raw yaml',
  manifest: { name: 'x' },
  env: [{ name: 'FOO' }],
  open_code_raw: '{}',
  default_agent: 'bot',
  open_code_default_agent: 'bot',
  agent_discovery: 'declared',
  agents: [{ name: 'a' }],
  skills: [{ name: 's' }],
  commands: [{ name: 'c' }],
  manifest_health: manifestHealthOf('kortix.yaml', [
    { path: 'agents.a.tools', message: 'unknown tool "x".', severity: 'error', line: 3, column: 5 },
  ]),
};
const files = [{ path: 'a' }, { path: 'b' }, { path: 'c' }];
const ALL = { canFiles: true, canAgents: true, canSkills: true, canCommands: true };

describe('applyDetailCapabilityFilter — /detail per-capability section gating', () => {
  test('all caps → nothing filtered', () => {
    const out = applyDetailCapabilityFilter(sampleConfig, files, ALL);
    expect(out.config.agents).toEqual([{ name: 'a' }]);
    expect(out.config.skills).toEqual([{ name: 's' }]);
    expect(out.config.commands).toEqual([{ name: 'c' }]);
    expect(out.config.manifest_raw).toBe('raw yaml');
    expect(out.files).toHaveLength(3);
    expect(out.file_count).toBe(3);
  });

  test('no file.read → files dropped, config untouched', () => {
    const out = applyDetailCapabilityFilter(sampleConfig, files, { ...ALL, canFiles: false });
    expect(out.files).toEqual([]);
    expect(out.file_count).toBe(0);
    expect(out.config.agents).toEqual([{ name: 'a' }]);
  });

  test('no skill.read → skills emptied, agents/commands intact', () => {
    const out = applyDetailCapabilityFilter(sampleConfig, files, { ...ALL, canSkills: false });
    expect(out.config.skills).toEqual([]);
    expect(out.config.agents).toEqual([{ name: 'a' }]);
    expect(out.config.commands).toEqual([{ name: 'c' }]);
  });

  test('no agent.read → agents + discovery blanked', () => {
    const out = applyDetailCapabilityFilter(sampleConfig, files, { ...ALL, canAgents: false });
    expect(out.config.agents).toEqual([]);
    expect(out.config.agent_discovery).toBeNull();
    // The default names one of those agents, so it goes with them.
    expect(out.config.open_code_default_agent).toBeNull();
    expect(out.config.default_agent).toBeNull();
  });

  // A project member holds agent.read but not file.read. Blanking the
  // default for them made the composer fall back to the first agent
  // alphabetically (`harness-reflector`) and RUN it instead of `kortix`.
  test('agent.read without file.read → the default agent name survives', () => {
    const out = applyDetailCapabilityFilter(sampleConfig, files, { ...ALL, canFiles: false });
    expect(out.config.agents).toEqual([{ name: 'a' }]);
    expect(out.config.open_code_default_agent).toBe('bot');
    expect(out.config.default_agent).toBe('bot');
  });

  test('no command.read → commands emptied', () => {
    const out = applyDetailCapabilityFilter(sampleConfig, files, { ...ALL, canCommands: false });
    expect(out.config.commands).toEqual([]);
  });

  // The raw manifest and OpenCode config are repository files: file.read.
  test('no file.read → raw config blanked, structural signals kept', () => {
    const out = applyDetailCapabilityFilter(sampleConfig, files, { ...ALL, canFiles: false });
    expect(out.config.manifest_raw).toBeNull();
    expect(out.config.manifest).toEqual({});
    expect(out.config.env).toEqual([]);
    expect(out.config.open_code_raw).toBeNull();
    // Structural signals survive so the workspace shell still renders.
    expect(out.config.is_kortix_repo).toBe(true);
    expect(out.config.signals).toEqual({ manifest: true });
  });

  test('no file.read → the manifest health is restricted: no path, no issues', () => {
    const out = applyDetailCapabilityFilter(sampleConfig, files, { ...ALL, canFiles: false });
    expect(out.config.manifest_health).toEqual({ path: null, state: 'restricted', errors: 0, warnings: 0, issues: [] });
    expect(out.config).not.toHaveProperty('manifest_version');
  });

  test('with file.read the real health passes through untouched', () => {
    const out = applyDetailCapabilityFilter(sampleConfig, files, ALL);
    expect(out.config.manifest_health).toEqual({
      path: 'kortix.yaml',
      state: 'issues',
      errors: 1,
      warnings: 0,
      issues: [{ path: 'agents.a.tools', message: 'unknown tool "x".', severity: 'error', line: 3, column: 5 }],
    });
  });

  test('member profile (agent/skill/command reads, NO file.read) → rosters visible, files and raw config hidden', () => {
    const out = applyDetailCapabilityFilter(sampleConfig, files, {
      canFiles: false, canAgents: true, canSkills: true, canCommands: true,
    });
    expect(out.files).toEqual([]);
    expect(out.file_count).toBe(0);
    expect(out.config.agents).toEqual([{ name: 'a' }]);
    expect(out.config.skills).toEqual([{ name: 's' }]);
    expect(out.config.manifest_raw).toBeNull();
  });

  test('files capped at 300 but file_count is the true total', () => {
    const many = Array.from({ length: 350 }, (_, i) => ({ path: `f${i}` }));
    const out = applyDetailCapabilityFilter(sampleConfig, many, ALL);
    expect(out.files).toHaveLength(300);
    expect(out.file_count).toBe(350);
  });
});
