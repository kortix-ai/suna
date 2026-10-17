import { describe, expect, test } from 'bun:test';
import { type ManifestIssue, validateManifest } from '../index.ts';

import { GOLDEN_V3 as GOLDEN } from './fixtures/golden-v3.ts';

function check(yaml: string): { errors: ManifestIssue[]; warnings: ManifestIssue[] } {
  const result = validateManifest(yaml, 'yaml');
  return {
    errors: result.issues.filter((issue) => issue.severity === 'error'),
    warnings: result.issues.filter((issue) => issue.severity === 'warning'),
  };
}

const errorPaths = (yaml: string) => check(yaml).errors.map((issue) => issue.path);
const swap = (from: string, to: string) => {
  if (!GOLDEN.includes(from)) throw new Error(`fixture has no "${from}"`);
  return GOLDEN.replace(from, to);
};

describe('kortix_version 3: the golden manifest', () => {
  test('is valid with no warnings', () => {
    const { errors, warnings } = check(GOLDEN);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test('is YAML only', () => {
    expect(validateManifest(GOLDEN, 'toml').valid).toBe(false);
  });
});

describe('kortix_version 3: top-level keys', () => {
  test.each([
    ['opencode:\n  config_dir: harnesses/opencode', 'opencode'],
    ['pi:\n  config_dir: harnesses/pi', 'pi'],
    ['harnesses:\n  pi:\n    codemode: on', 'harnesses'],
    ['permission: allow', 'permission'],
    ['channels: []', 'channels'],
    ['sandboxes: []', 'sandboxes'],
    ['agentz: {}', 'agentz'],
  ])('rejects %s', (line, path) => {
    const { errors } = check(`${GOLDEN}\n${line}\n`);
    expect(errors.map((issue) => issue.path)).toContain(path);
  });

  test('a harness key names its replacement', () => {
    const { errors } = check(`${GOLDEN}\nharnesses:\n  pi:\n    codemode: on\n`);
    expect(errors.find((issue) => issue.path === 'harnesses')?.message).toContain('extensions');
  });

  test('default_agent must be a primary agent', () => {
    expect(errorPaths(swap('default_agent: assistant', 'default_agent: researcher'))).toContain('default_agent');
    expect(errorPaths(swap('default_agent: assistant', 'default_agent: nobody'))).toContain('default_agent');
  });
});

describe('kortix_version 3: registries', () => {
  test('a skill is a folder whose name is the skill name', () => {
    expect(errorPaths(swap('pdf: skills/pdf', 'pdf: skills/pdf-tools'))).toContain('skills.pdf');
    expect(errorPaths(swap('pdf: skills/pdf', 'pdf: ../skills/pdf'))).toContain('skills.pdf');
    expect(errorPaths(swap('pdf: skills/pdf', 'pdf: skills/pdf/SKILL.md'))).toContain('skills.pdf');
    expect(errorPaths(swap('pdf: skills/pdf', 'Pdf: skills/Pdf'))).toContain('skills.Pdf');
  });

  test('a project skill must not take a Kortix skill name', () => {
    expect(errorPaths(swap('pdf: skills/pdf', 'kortix-pdf: skills/kortix-pdf'))).toContain('skills.kortix-pdf');
  });

  test('a tool is a module path, never kortix:<name> and never a harness tool name', () => {
    expect(errorPaths(swap('lookup_order: tools/lookup_order.ts', 'lookup_order: kortix:web_search'))).toContain('tools.lookup_order');
    expect(errorPaths(swap('lookup_order: tools/lookup_order.ts', 'bash: tools/bash.ts'))).toContain('tools.bash');
    expect(errorPaths(swap('lookup_order: tools/lookup_order.ts', 'lookup_order: tools/lookup_order.py'))).toContain('tools.lookup_order');
  });

  test('a project tool may replace a Kortix tool', () => {
    expect(errorPaths(swap('lookup_order: tools/lookup_order.ts', 'web_search: tools/search.ts').replace('exclude: [lookup_order]', 'exclude: [web_search]'))).toEqual([]);
  });

  test('a command takes exactly one of prompt or prompt_file', () => {
    expect(errorPaths(swap('    prompt: Summarize $ARGUMENTS in five bullets.\n', '    description: nothing\n'))).toContain('commands.summarize');
    expect(errorPaths(swap('    prompt: Summarize $ARGUMENTS in five bullets.\n', '    prompt: x\n    prompt_file: a.md\n'))).toContain('commands.summarize');
    expect(errorPaths(swap('    prompt: Summarize', '    agent: assistant\n    prompt: Summarize'))).toContain('commands.summarize.agent');
    expect(errorPaths(swap('prompt_file: support/commands/weekly-report.md', 'prompt_file: support/commands/weekly-report.txt'))).toContain('commands.weekly-report.prompt_file');
  });

  test('an extension names at least one harness, each with a valid source', () => {
    expect(errorPaths(swap('  web-access:\n    pi: npm:pi-web-access@0.30.0', '  web-access: {}'))).toContain('extensions.web-access');
    expect(errorPaths(swap('pi: npm:pi-web-access@0.30.0', 'pi: npm:pi-web-access@^0.30.0'))).toContain('extensions.web-access.pi');
    expect(errorPaths(swap('pi: npm:pi-web-access@0.30.0', 'pi: ./extensions/x.ts'))).toContain('extensions.web-access.pi');
    expect(errorPaths(swap('opencode: extensions/audit.opencode.ts', 'opencode: npm:audit@1.0.0'))).toContain('extensions.audit.opencode');
    expect(errorPaths(swap('opencode: extensions/audit.opencode.ts', 'claude: x.ts'))).toContain('extensions.audit.claude');
    expect(errorPaths(swap('extensions: ["extensions/*.ts"]', 'bogus: []'))).toContain('extensions.mcp-adapter.pi.bogus');
  });
});

describe('kortix_version 3: agents', () => {
  test.each([
    ['file: agents/x.md', 'file'],
    ['disable: true', 'disable'],
    ['opencode: {}', 'opencode'],
    ['harnesses: {}', 'harnesses'],
    ['env: all', 'env'],
    ['kortix_cli: all', 'kortix_cli'],
    ['connectors_personal: []', 'connectors_personal'],
    ['repository_access: true', 'repository_access'],
    ['temprature: 0.2', 'temprature'],
  ])('rejects agent key %s', (line, key) => {
    expect(errorPaths(swap('    mode: primary\n', `    mode: primary\n    ${line}\n`))).toContain(`agents.assistant.${key}`);
  });

  test('prompt and prompt_file are exclusive', () => {
    expect(errorPaths(swap('    prompt_file: agents/assistant.md\n', '    prompt_file: agents/assistant.md\n    prompt: hi\n'))).toContain('agents.assistant.prompt_file');
  });

  test('permission rejects skill and task: the grants own them', () => {
    expect(errorPaths(swap('      external_directory: deny', '      skill: allow'))).toContain('agents.assistant.permission.skill');
    expect(errorPaths(swap('      external_directory: deny', '      task: allow'))).toContain('agents.assistant.permission.task');
    expect(errorPaths(swap('      external_directory: deny', '      external_directory: maybe'))).toContain('agents.assistant.permission.external_directory');
  });

  test('every grant names something registered', () => {
    expect(errorPaths(swap('skills: [triage-rules, kortix-system]', 'skills: [triage-rules, nope]'))).toContain('agents.researcher.skills');
    expect(errorPaths(swap('commands: [weekly-report, summarize]', 'commands: [weekly-report, nope]'))).toContain('agents.assistant.commands');
    expect(errorPaths(swap('extensions: [audit, web-access]', 'extensions: [audit, nope]'))).toContain('agents.assistant.extensions');
    expect(errorPaths(swap('exclude: [lookup_order]', 'exclude: [nope]'))).toContain('agents.researcher.tools');
  });

  test('subagents name other declared subagents', () => {
    expect(errorPaths(swap('subagents: [researcher]', 'subagents: [nobody]'))).toContain('agents.assistant.subagents');
    expect(errorPaths(swap('subagents: [researcher]', 'subagents: [assistant]'))).toContain('agents.assistant.subagents');
    expect(errorPaths(swap('    mode: subagent\n', '    mode: subagent\n    enabled: false\n'))).toContain('agents.assistant.subagents');
  });

  test('tools rejects the v2 map form', () => {
    expect(errorPaths(swap('    tools: all\n', '    tools:\n      bash: false\n'))).toContain('agents.assistant.tools');
  });

  test('codemode is on, only or off', () => {
    expect(errorPaths(swap('codemode: on', 'codemode: maybe'))).toContain('agents.assistant.codemode');
  });

  test('connectors_required stays a subset of connectors', () => {
    expect(errorPaths(swap('    connectors: all\n', '    connectors: [a]\n    connectors_required: [b]\n'))).toContain('agents.assistant.connectors_required');
  });

  test('a trigger names a declared agent', () => {
    expect(errorPaths(swap('    agent: assistant\n    cron', '    agent: nobody\n    cron'))).toContain('triggers[0].agent');
  });
});

describe('agents.<name>.workspace.project_repository default', () => {
  test('defaults to true for v1/v2 and false when the caller passes the v3 default', async () => {
    const { resolveProjectRepository, projectRepositoryDefault } = await import('../index.ts');
    expect(resolveProjectRepository({})).toEqual({ ok: true, value: true, legacyRead: false });
    expect(resolveProjectRepository({}, projectRepositoryDefault(2))).toEqual({ ok: true, value: true, legacyRead: false });
    expect(resolveProjectRepository({}, projectRepositoryDefault(3))).toEqual({ ok: true, value: false, legacyRead: false });
    expect(resolveProjectRepository({ workspace: {} }, projectRepositoryDefault(3))).toEqual({ ok: true, value: false, legacyRead: false });
    expect(resolveProjectRepository({ workspace: { project_repository: true } }, projectRepositoryDefault(3))).toEqual({ ok: true, value: true, legacyRead: false });
    expect(projectRepositoryDefault(1)).toBe(true);
  });
});
