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
