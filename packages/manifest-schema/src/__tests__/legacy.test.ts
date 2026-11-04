/**
 * Legacy formats still work: a `kortix_version: 2` or `kortix.toml` project is
 * read as the latest shape (with the files it points at), and the same
 * conversion is what `--fix` writes. Synthetic projects only.
 */
import { describe, expect, test } from 'bun:test';
import {
  convertLegacyManifest,
  convertLegacyManifestAsync,
  fixManifestText,
  KORTIX_TOOL_NAMES,
  legacyFormatOf,
  parseLegacyToml,
  parseManifestText,
  selectedKortixTools,
  usableManifest,
  validateManifest,
} from '../index.ts';

const V2 = `# A synthetic v2 project.
kortix_version: 2
default_agent: lead
project:
  name: Synthetic
env:
  optional: [HELPDESK_TOKEN]
opencode:
  config_dir: harnesses/opencode
tools:
  web_search: kortix:web_search
  memory: kortix:memory
  lookup_order: tools/lookup_order.ts
harnesses:
  opencode:
    plugins: [audit.ts]
  pi:
    packages: [npm:pi-web-access@0.30.0]
    codemode: only
agents:
  lead:
    file: agents/lead.md
    connectors: all
    secrets: [HELPDESK_TOKEN]
    kortix_cli: all
    skills: all
  reviewer:
    skills: [triage, kortix-system]
    repository_access: false
    harnesses:
      opencode:
        exclude: [audit.ts]
        plugins: [notes.ts]
      pi:
        exclude: [pi-web-access]
triggers:
  - slug: nightly
    type: cron
    agent: reviewer
    cron: "0 0 3 * * *"
    prompt: Review.
`;

const FILES: Record<string, string> = {
  'kortix.yaml': V2,
  'agents/lead.md': '---\ndescription: Leads the work.\nmode: primary\nmodel: kortix/glm-5.3-flash\ntemperature: 0.2\n---\n\nYou lead.\n',
  'agents/reviewer.md': '---\ndescription: Reviews.\nmode: subagent\npermission:\n  edit: deny\n  task:\n    "*": deny\n---\nYou review.\n',
  'harnesses/opencode/opencode.jsonc': '{\n  // the project default\n  "$schema": "https://opencode.ai/config.json",\n  "permission": { "bash": "ask" },\n  "default_agent": "lead",\n}\n',
  'harnesses/opencode/plugins/audit.ts': 'export default async () => ({})\n',
  'harnesses/opencode/plugins/notes.ts': 'export default async () => ({})\n',
  'harnesses/opencode/plugins/lib/helper.ts': 'export {}\n',
  'harnesses/opencode/package.json': '{ "name": "cfg", "dependencies": { "zod": "4.1.8" } }\n',
  'harnesses/opencode/commands/weekly-report.md': '---\ndescription: Write the weekly report.\nagent: reviewer\n---\nReport on $ARGUMENTS.\n',
  'harnesses/opencode/commands/standup.md': '---\ndescription: Standup notes.\n---\nWrite standup notes.\n',
  'skills/triage/SKILL.md': '---\nname: triage\ndescription: Sort tickets.\n---\nBody.\n',
  'skills/kortix-cli/SKILL.md': '---\nname: kortix-cli\n---\nManaged.\n',
  'tools/lookup_order.ts': 'export default {}\n',
};

const repo = (files: Record<string, string>) => ({ paths: Object.keys(files), read: (path: string) => files[path] ?? null });
/** The Kortix tools a v2 `tools:` map that names only web_search and memory switched off. */
const ON = selectedKortixTools({ web_search: 'kortix:web_search', memory: 'kortix:memory' });
const OFF = KORTIX_TOOL_NAMES.filter((name) => !ON.includes(name));

describe('a kortix_version 2 project', () => {
  const conversion = () => convertLegacyManifest(parseManifestText(V2), 2, 'kortix.yaml', repo(FILES));

  test('validates with one warning that says it still works, and is not read as the current shape unconverted', () => {
    const result = validateManifest(V2);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([expect.objectContaining({ path: 'kortix_version', severity: 'warning', fix: 'legacy-format', line: 2 })]);
    expect(legacyFormatOf(result.parsed)).toBe(2);
    expect(usableManifest(result.parsed, result.issues)).toEqual({});
  });

  test('converts to the latest shape: registries, every agent with its behavior and grants', () => {
    const { raw, dropped } = conversion();
    expect(validateManifest(raw).issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(raw.kortix_version).toBeUndefined();
    expect(raw.skills).toEqual({ triage: 'skills/triage' });
    expect(raw.tools).toEqual({ lookup_order: 'tools/lookup_order.ts' });
    expect(raw.commands).toEqual({
      standup: { description: 'Standup notes.', prompt_file: 'commands/standup.md' },
      'weekly-report': { description: 'Write the weekly report.', prompt_file: 'commands/weekly-report.md' },
    });
    expect(raw.extensions).toEqual({ 'pi-web-access': { pi: 'npm:pi-web-access@0.30.0' } });
    const agents = raw.agents as Record<string, Record<string, unknown>>;
    expect(agents.lead).toEqual({
      description: 'Leads the work.',
      mode: 'primary',
      model: 'kortix/glm-5.3-flash',
      temperature: 0.2,
      prompt_file: 'agents/lead.md',
      permission: { bash: 'ask' },
      tools: { exclude: OFF },
      skills: 'all',
      subagents: 'all',
      commands: ['standup'],
      extensions: ['pi-web-access'],
      codemode: 'only',
      connectors: 'all',
      secrets: ['HELPDESK_TOKEN'],
      kortix_permissions: 'all',
      // v2 cloned the repository when the key was omitted.
      workspace: { project_repository: true },
    });
    expect(agents.reviewer).toEqual({
      description: 'Reviews.',
      mode: 'subagent',
      prompt_file: 'agents/reviewer.md',
      permission: { edit: 'deny' },
      tools: { exclude: OFF },
      skills: ['triage', 'kortix-system'],
      commands: ['weekly-report'],
      codemode: 'only',
      workspace: { project_repository: false },
    });
    expect(raw.triggers).toEqual([{ slug: 'nightly', type: 'cron', agent: 'reviewer', cron: '0 0 3 * * *', prompt: 'Review.' }]);
    // OpenCode plugins did nothing on pi: reported, not carried over.
    expect(dropped).toEqual([
      'harnesses/opencode/plugins/audit.ts: an OpenCode plugin; every session runs pi, which does not load it',
      'harnesses/opencode/plugins/notes.ts: an OpenCode plugin; every session runs pi, which does not load it',
    ]);
  });

  test('the overlay is what a reader uses for each prompt: the body without its frontmatter', () => {
    const { overlay } = conversion();
    expect(overlay['agents/lead.md']).toBe('You lead.\n');
    expect(overlay['agents/reviewer.md']).toBe('You review.\n');
    expect(overlay['commands/weekly-report.md']).toBe('Report on $ARGUMENTS.\n');
  });

  test('the changes --fix applies: the manifest, the prompt files, the deleted harness files', () => {
    const { changes } = conversion();
    const byPath = new Map(changes.map((change) => [`${change.action} ${change.path}`, change]));
    expect(changes[0]).toMatchObject({ path: 'kortix.yaml', action: 'rewrite' });
    const written = changes[0]!.content!;
    expect(written.startsWith('# yaml-language-server: $schema=https://kortix.com/schema/kortix.schema.json\n')).toBe(true);
    expect(validateManifest(written).issues).toEqual([]);
    expect(fixManifestText(written).fixed).toEqual([]);
    for (const key of ['rewrite agents/lead.md', 'rewrite commands/standup.md', 'delete harnesses/opencode/commands/standup.md', 'delete harnesses/opencode/opencode.jsonc']) {
      expect(byPath.has(key)).toBe(true);
    }
  });

  test('an agent only the OpenCode folder declared becomes a declared agent with its prompt', () => {
    const files = { ...FILES, 'harnesses/opencode/agents/helper.md': '---\ndescription: Helps the lead.\nmode: subagent\nmodel: kortix/glm-5.3-flash\npermission: allow\n---\nYou help.\n' };
    const { raw, overlay, changes } = convertLegacyManifest(parseManifestText(V2), 2, 'kortix.yaml', repo(files));
    const agents = raw.agents as Record<string, Record<string, unknown>>;
    expect(agents.helper).toMatchObject({ description: 'Helps the lead.', mode: 'subagent', prompt_file: 'agents/helper.md', skills: 'all' });
    expect(overlay['agents/helper.md']).toBe('You help.\n');
    expect(changes.some((c) => c.action === 'delete' && c.path === 'harnesses/opencode/agents/helper.md')).toBe(true);
  });

  test('a block key the conversion does not read is kept as written: an inline prompt runs, a typo is reported at its line', () => {
    const text = 'kortix_version: 2\nagents:\n  helper:\n    prompt: You help.\n    descripton: Helps.\n    env: [HELPDESK_TOKEN]\n';
    const { raw, dropped } = convertLegacyManifest(parseManifestText(text), 2, 'kortix.yaml', repo({}));
    const helper = (raw.agents as Record<string, Record<string, unknown>>).helper!;
    expect(helper.prompt).toBe('You help.');
    // The v3-era `env` grant is a deprecation: it reads as `secrets`.
    expect(helper.secrets).toEqual(['HELPDESK_TOKEN']);
    expect(helper.env).toBeUndefined();
    expect(dropped).toEqual([]);
    expect(validateManifest(raw).issues).toEqual([expect.objectContaining({ path: 'agents.helper.descripton', severity: 'error', message: expect.stringContaining('Did you mean "description"?') })]);
  });

  test('an unknown agent key is an error that leaves the agent on; a runtime table is dropped with a note', () => {
    const text = 'kortix_version: 2\nruntime:\n  root: .opencode\nagents:\n  helper:\n    prompt: You help.\n    excluded_skills: [pdf]\n';
    const { raw, dropped } = convertLegacyManifest(parseManifestText(text), 2, 'kortix.yaml', repo({}));
    expect(raw.runtime).toBeUndefined();
    expect(dropped).toEqual(['runtime: not a harness name; every session runs pi']);
    const { issues } = validateManifest(raw);
    expect(issues).toEqual([expect.objectContaining({ path: 'agents.helper.excluded_skills', severity: 'error', unknownKey: true })]);
    expect((usableManifest(raw, issues).agents as Record<string, { enabled?: boolean }>).helper?.enabled).not.toBe(false);
  });

  test('an inline prompt next to the agent file is reported: the file is the prompt', () => {
    const text = 'kortix_version: 2\nagents:\n  lead:\n    file: agents/lead.md\n    prompt: Ignored.\n';
    const { raw, dropped } = convertLegacyManifest(parseManifestText(text), 2, 'kortix.yaml', repo({ 'agents/lead.md': 'You lead.\n' }));
    expect((raw.agents as Record<string, Record<string, unknown>>).lead!.prompt).toBeUndefined();
    expect(dropped).toEqual(["agents.lead.prompt: agents/lead.md is this agent's prompt"]);
  });

  test('the async reader gives the same conversion, reading each file once', async () => {
    const reads: string[] = [];
    const conversion2 = await convertLegacyManifestAsync(parseManifestText(V2), 2, 'kortix.yaml', Object.keys(FILES), async (path) => {
      reads.push(path);
      return FILES[path] ?? null;
    });
    expect(conversion2).toEqual(conversion());
    expect(new Set(reads).size).toBe(reads.length);
  });
});

describe('a kortix.toml (kortix_version = 1) project', () => {
  const TOML = 'kortix_version = 1\n[project]\nname = "x"\n[env]\noptional = ["HELPDESK_TOKEN"]\n\n[[agents]]\nname = "ops"\nconnectors = "none"\nenv = ["HELPDESK_TOKEN"]\n';
  const files = {
    'kortix.toml': TOML,
    '.kortix/opencode/opencode.jsonc': '{ "default_agent": "ops", "permission": { "bash": "ask" } }\n',
    '.kortix/opencode/agents/ops.md': '---\nmode: primary\ndescription: Runs ops.\n---\nYou run ops.\n',
    '.kortix/opencode/agents/helper.md': '---\nmode: subagent\n---\nYou help.\n',
  };

  test('converts: omitted grants are all, env is secrets, the folder agents are declared, kortix.toml goes', () => {
    const { raw, overlay, changes, from } = convertLegacyManifest(parseLegacyToml(TOML), 1, 'kortix.toml', repo(files));
    expect(from).toBe(1);
    expect(validateManifest(raw).issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(raw.default_agent).toBe('ops');
    const agents = raw.agents as Record<string, Record<string, unknown>>;
    expect(agents.ops).toMatchObject({ mode: 'primary', description: 'Runs ops.', permission: { bash: 'ask' }, connectors: 'none', secrets: ['HELPDESK_TOKEN'], kortix_permissions: 'all', skills: 'all', workspace: { project_repository: true } });
    expect(agents.helper).toMatchObject({ mode: 'subagent', connectors: 'all', secrets: 'all', kortix_permissions: 'all', skills: 'all' });
    expect(overlay[agents.ops!.prompt_file as string]).toBe('You run ops.\n');
    expect(changes[0]).toMatchObject({ path: 'kortix.yaml', action: 'rewrite' });
    expect(changes.some((c) => c.action === 'delete' && c.path === 'kortix.toml')).toBe(true);
  });
});
