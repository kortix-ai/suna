import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * `imports:` in kortix.yaml, exercised through the CLI as a real process in a
 * working tree split across files — the same layout a 30-trigger project uses:
 *
 *   kortix.yaml                       root: version, default agent, imports
 *   .kortix/agents.yaml               imported file
 *   .kortix/triggers/**\/*.yaml        imported directory, nested
 */

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');

let tmp: string;

const ROOT = `# root manifest — keep this comment
kortix_version: 2
default_agent: kortix
imports:
  - .kortix/triggers/
  - .kortix/agents.yaml
agents:
  kortix:
    connectors: all
`;

const WEEKLY = `# weekly report — keep this comment
triggers:
  - slug: weekly-report
    name: Weekly report
    type: cron
    agent: galileo
    enabled: true
    cron: "0 0 15 * * 0"
    prompt: |-
      SUNDAY RETRY RUN.

      STEP 1 - check sent items.
`;

const DOCKETS = `triggers:
  - slug: docket-monitor
    type: cron
    cron: "0 0 9 * * 1-5"
    prompt: check the docket
  - slug: docket-digest
    type: cron
    cron: "0 0 17 * * 5"
    prompt: weekly docket digest
`;

function write(files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(tmp, path)), { recursive: true });
    writeFileSync(join(tmp, path), content, 'utf8');
  }
}

function read(path: string): string {
  return readFileSync(join(tmp, path), 'utf8');
}

async function runCli(args: string[]) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    KORTIX_NO_UPDATE_CHECK: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    KORTIX_CONFIG_FILE: join(tmp, 'config.json'),
  };
  for (const key of ['KORTIX_API_URL', 'KORTIX_TOKEN', 'KORTIX_PROJECT_ID', 'BASH_ENV']) {
    delete env[key];
  }
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: tmp,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => proc.kill(), 15_000);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => clearTimeout(timeout));
  return { code, stdout, stderr };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'kortix-imports-'));
  write({
    'kortix.yaml': ROOT,
    '.kortix/agents.yaml': 'agents:\n  galileo:\n    connectors: none\n',
    '.kortix/triggers/reports/weekly.yaml': WEEKLY,
    '.kortix/triggers/dockets.yaml': DOCKETS,
    'config.json': JSON.stringify({ active: 'test', hosts: {} }),
  });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('kortix validate — imports', () => {
  test('a split manifest validates as one document (cross-file agent reference resolves)', async () => {
    const result = await runCli(['validate', '--json']);
    const report = JSON.parse(result.stdout);
    expect(report.issues.filter((i: { severity: string }) => i.severity === 'error')).toEqual([]);
    expect(report.valid).toBe(true);
    expect(result.code).toBe(0);
  });

  test('a trigger that names an agent no file declares fails, across files', async () => {
    write({ '.kortix/agents.yaml': 'agents:\n  someone-else:\n    connectors: none\n' });
    const result = await runCli(['validate', '--json']);
    const report = JSON.parse(result.stdout);
    expect(result.code).toBe(1);
    expect(JSON.stringify(report.issues)).toContain('galileo');
  });

  test('a duplicate slug across two files is an error that names both files', async () => {
    write({
      '.kortix/triggers/clash.yaml':
        'triggers:\n  - slug: weekly-report\n    type: cron\n    cron: "0 0 1 * * *"\n    prompt: dup\n',
    });
    const result = await runCli(['validate', '--json']);
    const report = JSON.parse(result.stdout);
    expect(result.code).toBe(1);
    expect(report.valid).toBe(false);
    expect(report.issues).toContainEqual({
      path: 'imports',
      message:
        'triggers "weekly-report" is declared in both .kortix/triggers/clash.yaml and .kortix/triggers/reports/weekly.yaml — one name, one file',
      severity: 'error',
    });
  });

  test('a missing import and a path escaping the repository are errors', async () => {
    write({ 'kortix.yaml': ROOT.replace('.kortix/agents.yaml', '.kortix/nope.yaml') });
    let report = JSON.parse((await runCli(['validate', '--json'])).stdout);
    expect(report.valid).toBe(false);
    expect(JSON.stringify(report.issues)).toContain(
      'import \\".kortix/nope.yaml\\" matches no .yaml or .yml file',
    );

    write({ 'kortix.yaml': ROOT.replace('.kortix/agents.yaml', '../outside.yaml') });
    report = JSON.parse((await runCli(['validate', '--json'])).stdout);
    expect(report.valid).toBe(false);
    expect(report.issues.some((i: { path: string }) => i.path === 'imports[1]')).toBe(true);
  });
});

describe('kortix triggers — edits land in the declaring file', () => {
  test('disable edits the imported file in place; the root and sibling files are untouched', async () => {
    const result = await runCli(['triggers', 'disable', 'weekly-report']);
    // stderr carries only the CLI's host banner line.
    expect(result.code).toBe(0);

    expect(read('.kortix/triggers/reports/weekly.yaml')).toBe(
      WEEKLY.replace('enabled: true', 'enabled: false'),
    );
    expect(read('kortix.yaml')).toBe(ROOT);
    expect(read('.kortix/triggers/dockets.yaml')).toBe(DOCKETS);
  });

  test('rm removes the entry from the imported file and leaves its sibling entry', async () => {
    const result = await runCli(['triggers', 'rm', 'docket-monitor']);
    expect(result.code).toBe(0);
    expect(read('.kortix/triggers/dockets.yaml')).toBe(
      DOCKETS.replace(
        '  - slug: docket-monitor\n    type: cron\n    cron: "0 0 9 * * 1-5"\n    prompt: check the docket\n',
        '',
      ),
    );
    expect(read('kortix.yaml')).toBe(ROOT);
    expect((await runCli(['validate', '--json'])).code).toBe(0);
  });

  test('add refuses a slug an imported file already declares', async () => {
    const result = await runCli([
      'triggers', 'add', 'weekly-report', '--cron', '0 0 1 * * *', '--prompt', 'dup',
    ]);
    expect(result.code).not.toBe(0);
    expect(read('kortix.yaml')).toBe(ROOT);
  });

  test('add writes a new trigger to the root manifest, and the result still validates', async () => {
    const result = await runCli([
      'triggers', 'add', 'brand-new', '--cron', '0 0 1 * * *', '--prompt', 'hello',
    ]);
    expect(result.code).toBe(0);
    expect(read('kortix.yaml')).toContain('slug: brand-new');
    expect(read('kortix.yaml')).toContain('# root manifest — keep this comment');
    expect(read('.kortix/triggers/reports/weekly.yaml')).toBe(WEEKLY);
    expect((await runCli(['validate', '--json'])).code).toBe(0);
  });
});
