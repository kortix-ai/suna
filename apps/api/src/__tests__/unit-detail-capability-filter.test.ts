import { describe, test, expect } from 'bun:test';
import { applyDetailCapabilityFilter } from '../projects/lib/detail-capability-filter';

// Record<string, unknown> so the filtered fields (which the runtime blanks to
// {} / [] / null) type as `unknown` at the assertions — otherwise the literal
// type (e.g. manifest: { name: string }) rejects `.toEqual({})`.
const sampleConfig: Record<string, unknown> = {
  is_kortix_repo: true,
  signals: { manifest: true },
  manifest_raw: 'raw toml',
  manifest: { name: 'x' },
  env: [{ name: 'FOO' }],
  open_code_raw: '{}',
  open_code_default_agent: 'bot',
  agent_discovery: 'declared',
  agents: [{ name: 'a' }],
  skills: [{ name: 's' }],
  commands: [{ name: 'c' }],
};
const files = [{ path: 'a' }, { path: 'b' }, { path: 'c' }];
const ALL = { canFiles: true, canAgents: true, canSkills: true, canCommands: true, canCustomize: true };

describe('applyDetailCapabilityFilter — /detail per-capability section gating', () => {
  test('all caps → nothing filtered', () => {
    const out = applyDetailCapabilityFilter(sampleConfig, files, ALL);
    expect(out.config.agents).toEqual([{ name: 'a' }]);
    expect(out.config.skills).toEqual([{ name: 's' }]);
    expect(out.config.commands).toEqual([{ name: 'c' }]);
    expect(out.config.manifest_raw).toBe('raw toml');
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
  });

  test('no command.read → commands emptied', () => {
    const out = applyDetailCapabilityFilter(sampleConfig, files, { ...ALL, canCommands: false });
    expect(out.config.commands).toEqual([]);
  });

  test('no customize.read → raw config blanked, structural signals kept', () => {
    const out = applyDetailCapabilityFilter(sampleConfig, files, { ...ALL, canCustomize: false });
    expect(out.config.manifest_raw).toBeNull();
    expect(out.config.manifest).toEqual({});
    expect(out.config.env).toEqual([]);
    expect(out.config.open_code_raw).toBeNull();
    expect(out.config.open_code_default_agent).toBeNull();
    // Structural signals survive so the workspace shell still renders.
    expect(out.config.is_kortix_repo).toBe(true);
    expect(out.config.signals).toEqual({ manifest: true });
  });

  test('member profile (all config reads, NO file.read) → config visible, file list hidden', () => {
    const out = applyDetailCapabilityFilter(sampleConfig, files, {
      canFiles: false, canAgents: true, canSkills: true, canCommands: true, canCustomize: true,
    });
    expect(out.files).toEqual([]);
    expect(out.file_count).toBe(0);
    expect(out.config.agents).toEqual([{ name: 'a' }]);
    expect(out.config.skills).toEqual([{ name: 's' }]);
    expect(out.config.manifest_raw).toBe('raw toml');
  });

  test('files capped at 300 but file_count is the true total', () => {
    const many = Array.from({ length: 350 }, (_, i) => ({ path: `f${i}` }));
    const out = applyDetailCapabilityFilter(sampleConfig, many, ALL);
    expect(out.files).toHaveLength(300);
    expect(out.file_count).toBe(350);
  });
});
