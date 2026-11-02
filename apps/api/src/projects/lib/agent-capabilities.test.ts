import { describe, expect, test } from 'bun:test';
import { KORTIX_SKILL_NAMES, KORTIX_TOOL_NAMES } from '@kortix/manifest-schema';
import { PLATFORM_EXTENSION_IDS } from '@kortix/api-contract/runtime-relay';
import { buildAgentCapabilities } from './agent-capabilities';

const MANIFEST = {
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
    managedSkills: [
      { name: 'kortix-system', description: 'How Kortix works.', featureFlag: null },
      { name: 'kortix-goals', description: 'Goals.', featureFlag: 'goals' },
    ],
    projectSkillDescriptions: { pdf: 'Make PDFs.' },
    enabledFlags: new Set(flags),
  });

describe('buildAgentCapabilities', () => {
  test('lists every tool once, grouped, with the agent tool carrying its task alias and the team tools under task_create', () => {
    const { tools } = build();
    const ids = tools.map((tool) => tool.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(tools.filter((tool) => tool.group === 'workspace').map((tool) => tool.id)).toEqual(['bash', 'read', 'write', 'edit', 'glob', 'grep', 'codemode']);
    // The tools of the builtin extensions are rows too, so each extension's switch is its tool's switch.
    expect(tools.filter((tool) => tool.group === 'interaction').map((tool) => tool.id)).toEqual(['question', 'agent', 'workflow', 'send_message', 'list_agents', 'task_create']);
    expect(tools.find((tool) => tool.id === 'agent')?.aliases).toEqual(['task']);
    expect(tools.find((tool) => tool.id === 'task_create')?.aliases).toEqual(['task_list', 'task_get', 'task_update']);
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

  test('the catalog carries the schema_version wire constant 3', () => {
    expect(build().schema_version).toBe(3);
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

  test('platform extensions: every builtin the runtime loads, three always on, the rest switched by a tool or the agent `context`; then the project ones', () => {
    const { extensions, tools } = build();
    expect(extensions.map((ext) => [ext.id, ext.group, ext.required, ext.controlled_by])).toEqual([
      ['kortix-nested-calls', 'platform', true, null],
      ['kortix-presentation', 'platform', true, null],
      ['kortix-turn', 'platform', true, null],
      ['kortix-context-record', 'platform', false, 'context'],
      ['kortix-subagents', 'platform', false, 'agent'],
      ['kortix-workflow', 'platform', false, 'workflow'],
      ['kortix-messaging', 'platform', false, 'send_message'],
      ['kortix-team-tasks', 'platform', false, 'task_create'],
      ['codemode', 'platform', false, 'codemode'],
      ['audit', 'project', false, null],
      ['web', 'project', false, null],
    ]);
    expect(extensions.find((ext) => ext.id === 'web')?.description).toBe('npm:pi-web-access@0.30.0');
    expect(extensions.filter((ext) => ext.group === 'platform').every((ext) => !!ext.description)).toBe(true);
    // The catalog is the shared list the daemon is held to (pi-harness: every loaded builtin is in it).
    expect(extensions.filter((ext) => ext.group === 'platform').map((ext) => ext.id).sort()).toEqual([...PLATFORM_EXTENSION_IDS].sort());
    // A builtin switched by a tool has that tool's row, so the agent page can show its switch.
    for (const ext of extensions.filter((e) => e.group === 'platform' && e.controlled_by && e.controlled_by !== 'context')) {
      expect(tools.map((tool) => tool.id)).toContain(ext.controlled_by!);
    }
  });
});
