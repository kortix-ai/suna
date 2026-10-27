import { describe, expect, test } from 'bun:test';
import { KORTIX_SKILL_NAMES, KORTIX_TOOL_NAMES } from '@kortix/manifest-schema';
import { buildAgentCapabilities } from './agent-capabilities';

const MANIFEST = {
  kortix_version: 3,
  default_agent: 'lead',
  skills: { pdf: 'skills/pdf' },
  tools: { lookup_order: 'tools/lookup_order.ts', web_search: 'tools/search.ts' },
  extensions: { audit: { pi: 'extensions/audit.pi.ts' }, web: { pi: 'npm:pi-web-access@0.30.0' } },
  agents: { lead: { prompt: 'Lead.' } },
};

const build = (flags: string[] = []) =>
  buildAgentCapabilities({
    agentName: 'lead',
    manifest: MANIFEST,
    schemaVersion: 3,
    managedSkills: [
      { name: 'kortix-system', description: 'How Kortix works.', featureFlag: null },
      { name: 'kortix-goals', description: 'Goals.', featureFlag: 'goals' },
    ],
    projectSkillDescriptions: { pdf: 'Make PDFs.' },
    enabledFlags: new Set(flags),
  });

describe('buildAgentCapabilities', () => {
  test('lists every tool once, grouped, with the agent tool carrying its task alias', () => {
    const { tools } = build();
    const ids = tools.map((tool) => tool.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(tools.filter((tool) => tool.group === 'workspace').map((tool) => tool.id)).toEqual(['bash', 'read', 'write', 'edit', 'glob', 'grep', 'codemode']);
    expect(tools.filter((tool) => tool.group === 'interaction').map((tool) => tool.id)).toEqual(['question', 'agent']);
    expect(tools.find((tool) => tool.id === 'agent')?.aliases).toEqual(['task']);
    expect(tools.filter((tool) => tool.group === 'kortix').map((tool) => tool.id)).toEqual([...KORTIX_TOOL_NAMES]);
    expect(tools.every((tool) => tool.description)).toBe(false);
    expect(tools.filter((tool) => tool.group !== 'project').every((tool) => !!tool.description)).toBe(true);
  });

  test('a project tool is its own row; a project module that replaces a Kortix tool marks that row', () => {
    const { tools } = build();
    expect(tools.filter((tool) => tool.group === 'project')).toEqual([
      { id: 'lookup_order', group: 'project', description: null, aliases: [], source: 'tools/lookup_order.ts' },
    ]);
    expect(tools.find((tool) => tool.id === 'web_search')?.source).toBe('tools/search.ts');
  });

  test('v2: kortix:<name> keeps a Kortix tool (no replacement), and only the Kortix tools a tools key lists exist', () => {
    const v2 = buildAgentCapabilities({
      agentName: 'lead',
      manifest: { kortix_version: 2, tools: { web_search: 'kortix:web_search', memory: 'tools/memory.ts', lookup: 'tools/lookup.ts' } },
      schemaVersion: 2,
      managedSkills: [],
      projectSkillDescriptions: {},
      enabledFlags: new Set(),
    });
    expect(v2.tools.filter((tool) => tool.group === 'kortix').map((tool) => [tool.id, tool.source])).toEqual([
      ['web_search', null],
      ['memory', 'tools/memory.ts'],
    ]);
    expect(v2.tools.filter((tool) => tool.group === 'project').map((tool) => tool.id)).toEqual(['lookup']);
  });

  test('built-in skills come with their description and flag; a flag that is off makes the row unavailable', () => {
    const off = build().skills;
    expect(off.find((skill) => skill.id === 'kortix-system')).toEqual({ id: 'kortix-system', group: 'builtin', description: 'How Kortix works.', feature_flag: null, available: true });
    expect(off.find((skill) => skill.id === 'kortix-goals')).toMatchObject({ feature_flag: 'goals', available: false });
    expect(build(['goals']).skills.find((skill) => skill.id === 'kortix-goals')?.available).toBe(true);
    expect(off.find((skill) => skill.id === 'pdf')).toEqual({ id: 'pdf', group: 'project', description: 'Make PDFs.', feature_flag: null, available: true });
  });

  test('every Kortix skill name has a row, even one without a skill file', () => {
    const ids = build().skills.filter((skill) => skill.group === 'builtin').map((skill) => skill.id);
    for (const name of KORTIX_SKILL_NAMES) expect(ids).toContain(name);
  });

  test('platform extensions: three always on, two driven by a tool switch; then the project ones', () => {
    const { extensions } = build();
    expect(extensions.map((ext) => [ext.id, ext.group, ext.required, ext.controlled_by])).toEqual([
      ['kortix-nested-calls', 'platform', true, null],
      ['kortix-presentation', 'platform', true, null],
      ['kortix-turn', 'platform', true, null],
      ['kortix-subagents', 'platform', false, 'agent'],
      ['codemode', 'platform', false, 'codemode'],
      ['audit', 'project', false, null],
      ['web', 'project', false, null],
    ]);
    expect(extensions.find((ext) => ext.id === 'web')?.description).toBe('npm:pi-web-access@0.30.0');
    expect(extensions.filter((ext) => ext.group === 'platform').every((ext) => !!ext.description)).toBe(true);
  });
});
