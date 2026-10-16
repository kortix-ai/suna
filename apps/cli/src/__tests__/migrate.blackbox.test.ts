import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseManifestText, validateManifest } from '@kortix/manifest-schema';

/**
 * `kortix migrate`: a kortix_version 2 project becomes kortix_version 3, run as
 * a real process on a synthetic v2 checkout. Preview by default; `--write`
 * applies it.
 */

const cli = join(import.meta.dir, '../index.ts');
let cwd: string;

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
  'harnesses/opencode/commands/weekly-report.md': '---\ndescription: Write the weekly report.\nagent: reviewer\n---\nReport on $ARGUMENTS.\n',
  'harnesses/opencode/commands/standup.md': '---\ndescription: Standup notes.\n---\nWrite standup notes.\n',
  'skills/triage/SKILL.md': '---\nname: triage\ndescription: Sort tickets.\n---\nBody.\n',
  'skills/kortix-cli/SKILL.md': '---\nname: kortix-cli\n---\nManaged.\n',
  'tools/lookup_order.ts': 'export default {}\n',
};

function write(files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }
}

function kortix(...args: string[]) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NO_COLOR: '1',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    KORTIX_NO_UPDATE_CHECK: '1',
    KORTIX_CONFIG_FILE: join(cwd, '.kortix-test-config.json'),
  };
  delete env.KORTIX_TOKEN;
  const result = Bun.spawnSync([process.execPath, cli, ...args], { cwd, env, timeout: 30_000 });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

const read = (path: string) => readFileSync(join(cwd, path), 'utf8');

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'kortix-migrate-'));
  write(FILES);
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe('kortix migrate (preview)', () => {
  test('prints the plan and the v3 manifest, and changes no file', () => {
    const result = kortix('migrate');

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('kortix_version 2 → 3');
    expect(result.stdout).toContain('agents/lead.md');
    expect(result.stdout).toContain('harnesses/opencode/opencode.jsonc');
    expect(result.stdout).toContain('--write');
    expect(result.stdout).toContain('kortix_version: 3');
    for (const [path, content] of Object.entries(FILES)) expect(read(path)).toBe(content);
  });

  test('--json reports a valid v3 manifest', () => {
    const result = kortix('migrate', '--json');
    const out = JSON.parse(result.stdout) as { valid: boolean; manifest: string; issues: unknown[] };

    expect(result.code).toBe(0);
    expect(out.valid).toBe(true);
    expect(validateManifest(out.manifest, 'yaml').issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });
});

describe('kortix migrate --write', () => {
  test('writes a valid v3 project that keeps every agent\'s behavior and grants', () => {
    const result = kortix('migrate', '--write');
    expect(result.code).toBe(0);

    const manifest = parseManifestText(read('kortix.yaml'), 'yaml') as Record<string, any>;
    expect(validateManifest(read('kortix.yaml'), 'yaml').issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(manifest.kortix_version).toBe(3);
    expect(manifest.opencode).toBeUndefined();
    expect(manifest.harnesses).toBeUndefined();

    // Registries.
    expect(manifest.skills).toEqual({ triage: 'skills/triage' });
    expect(manifest.tools).toEqual({ lookup_order: 'tools/lookup_order.ts' });
    expect(manifest.commands).toEqual({
      standup: { description: 'Standup notes.', prompt_file: 'harnesses/opencode/commands/standup.md' },
      'weekly-report': { description: 'Write the weekly report.', prompt_file: 'harnesses/opencode/commands/weekly-report.md' },
    });
    expect(manifest.extensions).toEqual({
      audit: { opencode: 'harnesses/opencode/plugins/audit.ts' },
      notes: { opencode: 'harnesses/opencode/plugins/notes.ts' },
      'pi-web-access': { pi: 'npm:pi-web-access@0.30.0' },
    });

    // lead: behavior from its .md, opencode.jsonc's permission, every plugin and package it loaded.
    expect(manifest.agents.lead).toEqual({
      description: 'Leads the work.',
      mode: 'primary',
      model: 'kortix/glm-5.3-flash',
      temperature: 0.2,
      prompt_file: 'agents/lead.md',
      permission: { bash: 'ask' },
      // v2 dropped every Kortix tool the tools key did not list.
      tools: { exclude: ['image_search', 'scrape_webpage', 'show', 'kortix-connectors_call', 'kortix-connectors_describe'] },
      skills: 'all',
      subagents: 'all',
      commands: ['standup'],
      extensions: ['audit', 'pi-web-access'],
      codemode: 'only',
      connectors: 'all',
      secrets: ['HELPDESK_TOKEN'],
      kortix_permissions: 'all',
    });
    // reviewer: its own permission wins; task deny → no subagents; its own plugin set.
    expect(manifest.agents.reviewer).toEqual({
      description: 'Reviews.',
      mode: 'subagent',
      prompt_file: 'agents/reviewer.md',
      permission: { edit: 'deny' },
      tools: { exclude: ['image_search', 'scrape_webpage', 'show', 'kortix-connectors_call', 'kortix-connectors_describe'] },
      skills: ['triage', 'kortix-system'],
      commands: ['weekly-report'],
      extensions: ['notes'],
      codemode: 'only',
      workspace: { project_repository: false },
    });
    expect(manifest.triggers).toEqual([{ slug: 'nightly', type: 'cron', agent: 'reviewer', cron: '0 0 3 * * *', prompt: 'Review.' }]);

    // Prompt files hold the prompt alone; opencode.jsonc is gone; plugin modules stay.
    expect(read('agents/lead.md')).toBe('You lead.\n');
    expect(read('agents/reviewer.md')).toBe('You review.\n');
    expect(read('harnesses/opencode/commands/weekly-report.md')).toBe('Report on $ARGUMENTS.\n');
    expect(existsSync(join(cwd, 'harnesses/opencode/opencode.jsonc'))).toBe(false);
    expect(existsSync(join(cwd, 'harnesses/opencode/plugins/audit.ts'))).toBe(true);

    expect(kortix('validate', '--json', '--no-dockerfile-lint').code).toBe(0);
  });

  test('a v3 project has nothing to migrate', () => {
    expect(kortix('migrate', '--write').code).toBe(0);
    const again = kortix('migrate');

    expect(again.code).toBe(0);
    expect(again.stdout).toContain('already kortix_version 3');
  });

  test('a v1 project is pointed at the v1 upgrade', () => {
    rmSync(join(cwd, 'kortix.yaml'));
    write({ 'kortix.toml': 'kortix_version = 1\n[project]\nname = "x"\n' });

    const result = kortix('migrate');

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('kortix projects upgrade');
  });
});

describe('kortix migrate (a manifest split with imports)', () => {
  const ROOT = `kortix_version: 2
default_agent: lead
imports:
  - desk/kortix.yaml
agents:
  lead:
    file: agents/lead.md
    connectors: all
`;
  const DESK = `# The desk feature: its agent, connector and trigger.
agents:
  desk-worker:
    file: desk/agents/desk-worker.md
    connectors: [desk]
connectors:
  - slug: desk
    provider: mcp
    url: https://desk.example.test/mcp
triggers:
  - slug: desk-sweep
    type: cron
    agent: desk-worker
    cron: "0 0 * * * *"
    prompt: Sweep the desk.
harnesses:
  pi:
    codemode: off
`;

  beforeEach(() => {
    rmSync(join(cwd, 'kortix.yaml'));
    write({
      'kortix.yaml': ROOT,
      'desk/kortix.yaml': DESK,
      'desk/agents/desk-worker.md': '---\ndescription: Works the desk.\nmode: subagent\n---\nYou work the desk.\n',
    });
  });

  test('--write keeps each entry in the file that declared it, and the project validates', () => {
    const result = kortix('migrate', '--write');
    expect(result.code).toBe(0);

    const root = parseManifestText(read('kortix.yaml'), 'yaml');
    expect(root.kortix_version).toBe(3);
    expect(root.imports).toEqual(['desk/kortix.yaml']);
    expect(Object.keys(root.agents as object)).toEqual(['lead']);
    expect(root.connectors).toBeUndefined();

    const desk = parseManifestText(read('desk/kortix.yaml'), 'yaml');
    expect(Object.keys(desk).sort()).toEqual(['agents', 'connectors', 'triggers']);
    expect(desk.agents).toMatchObject({ 'desk-worker': { description: 'Works the desk.', mode: 'subagent', prompt_file: 'desk/agents/desk-worker.md', connectors: ['desk'] } });
    expect(read('desk/agents/desk-worker.md')).toBe('You work the desk.\n');
    // `harnesses` cannot sit in an imported v3 file: it is reported, not kept.
    expect(result.stdout).toContain('desk/kortix.yaml: harnesses');

    const validate = kortix('validate');
    expect(validate.code).toBe(0);
  });

  test('preview changes no file', () => {
    expect(kortix('migrate').code).toBe(0);
    expect(read('kortix.yaml')).toBe(ROOT);
    expect(read('desk/kortix.yaml')).toBe(DESK);
  });
});

describe('kortix migrate (agents only the OpenCode folder declared)', () => {
  test('an undeclared OpenCode agent file becomes a declared agent with its behavior, prompt and skills', () => {
    write({
      'harnesses/opencode/agents/helper.md': '---\ndescription: Helps the lead.\nmode: subagent\nmodel: kortix/glm-5.3-flash\npermission: allow\n---\nYou help.\n',
    });
    const result = kortix('migrate', '--write');
    expect(result.code).toBe(0);
    const manifest = parseManifestText(read('kortix.yaml'), 'yaml');
    const agents = manifest.agents as Record<string, Record<string, unknown>>;
    // v2 loaded it from the folder, unrestricted; v3 declares it and keeps that.
    expect(agents.helper).toMatchObject({ description: 'Helps the lead.', mode: 'subagent', model: 'kortix/glm-5.3-flash', prompt_file: 'agents/helper.md', skills: 'all' });
    expect(read('agents/helper.md')).toBe('You help.\n');
    expect(existsSync(join(cwd, 'harnesses/opencode/agents/helper.md'))).toBe(false);
    // `lead` had no task rule in v2, so it may still start every subagent, now including helper.
    expect(agents.lead!.subagents).toBe('all');
    expect(validateManifest(read('kortix.yaml'), 'yaml').issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });
});
