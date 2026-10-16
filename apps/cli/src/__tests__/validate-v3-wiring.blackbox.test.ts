import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * `kortix validate` on a kortix_version 3 project, as a real process: every
 * file the manifest names must exist, every registered skill folder must hold
 * a SKILL.md named after it, and every connector and secret an agent enables
 * must be declared.
 */

const cli = join(import.meta.dir, '../index.ts');
let cwd: string;

const MANIFEST = `kortix_version: 3
default_agent: lead
env:
  required: [HELPDESK_TOKEN]
connectors:
  - slug: crm
    provider: pipedream
    app: hubspot
skills:
  triage: support/skills/triage
tools:
  lookup_order: tools/lookup_order.ts
commands:
  report:
    prompt_file: commands/report.md
extensions:
  audit:
    opencode: extensions/audit/audit.ts
    pi: extensions/audit/pi
  web:
    pi: npm:pi-web-access@0.30.0
agents:
  lead:
    mode: primary
    prompt_file: agents/lead.md
    skills: all
    commands: [report]
    extensions: [audit, web]
    connectors: [crm]
    secrets: [HELPDESK_TOKEN]
`;

const FILES: Record<string, string> = {
  'kortix.yaml': MANIFEST,
  'agents/lead.md': 'You lead.\n',
  'commands/report.md': 'Report on $ARGUMENTS.\n',
  'support/skills/triage/SKILL.md': '---\nname: triage\ndescription: Sort tickets.\n---\nBody.\n',
  'tools/lookup_order.ts': 'export default {}\n',
  'extensions/audit/audit.ts': 'export default {}\n',
  'extensions/audit/pi/index.ts': 'export default {}\n',
};

function write(files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }
}

function validate(): { exitCode: number; issues: Array<{ path: string; message: string; severity: string }> } {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NO_COLOR: '1',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    KORTIX_NO_UPDATE_CHECK: '1',
    KORTIX_CONFIG_FILE: join(cwd, 'config.json'),
  };
  delete env.KORTIX_TOKEN;
  delete env.KORTIX_SESSION_ID;
  delete env.KORTIX_API_URL;
  const result = Bun.spawnSync([process.execPath, cli, 'validate', '--json', '--no-dockerfile-lint'], { cwd, env });
  const parsed = JSON.parse(result.stdout.toString()) as { issues: Array<{ path: string; message: string; severity: string }> };
  return { exitCode: result.exitCode ?? -1, issues: parsed.issues.filter((issue) => issue.severity === 'error') };
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'validate-v3-'));
  write(FILES);
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe('kortix validate on kortix_version 3', () => {
  test('a project whose every reference resolves is valid', () => {
    expect(validate()).toEqual({ exitCode: 0, issues: [] });
  });

  test.each([
    ['agents/lead.md', 'agents.lead.prompt_file'],
    ['commands/report.md', 'commands.report.prompt_file'],
    ['tools/lookup_order.ts', 'tools.lookup_order'],
    ['extensions/audit/audit.ts', 'extensions.audit.opencode'],
    ['support/skills/triage/SKILL.md', 'skills.triage'],
  ])('a missing %s is an error at %s', (path, issuePath) => {
    rmSync(join(cwd, path));

    const result = validate();

    expect(result.exitCode).toBe(1);
    expect(result.issues.map((issue) => issue.path)).toEqual([issuePath]);
  });

  test('a missing repo-path pi package is an error; an npm pin is not checked', () => {
    rmSync(join(cwd, 'extensions/audit/pi'), { recursive: true });

    expect(validate().issues.map((issue) => issue.path)).toEqual(['extensions.audit.pi']);
  });

  test('a SKILL.md whose frontmatter name differs from the registered name is an error', () => {
    write({ 'support/skills/triage/SKILL.md': '---\nname: sorting\n---\n' });

    const result = validate();

    expect(result.issues.map((issue) => issue.path)).toEqual(['skills.triage']);
    expect(result.issues[0]!.message).toContain('"sorting"');
  });

  test('an undeclared secret or connector is an error', () => {
    write({ 'kortix.yaml': MANIFEST.replace('secrets: [HELPDESK_TOKEN]', 'secrets: [OTHER_TOKEN]').replace('connectors: [crm]', 'connectors: [erp]') });

    expect(validate().issues.map((issue) => issue.path).sort()).toEqual(['agents.lead.connectors[0]', 'agents.lead.secrets[0]']);
  });

  test('the shipped starter validates with zero errors', async () => {
    const { getStarterFiles } = await import('@kortix/starter');
    rmSync(cwd, { recursive: true, force: true });
    mkdirSync(cwd);
    write(Object.fromEntries(getStarterFiles({ projectName: 'Acme', manifestVersion: 3 }).map((file) => [file.path, file.content])));

    expect(validate()).toEqual({ exitCode: 0, issues: [] });
  });
});

