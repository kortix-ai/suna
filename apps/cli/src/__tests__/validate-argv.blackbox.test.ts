import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const cli = join(import.meta.dir, '../index.ts');

function validate(args: string[]) {
  const cwd = mkdtempSync(join(tmpdir(), 'validate-argv-'));
  try {
    writeFileSync(join(cwd, 'kortix.yaml'), 'invalid: true\n');
    writeFileSync(join(cwd, 'selected.yaml'), 'project:\n  name: argv-test\n');
    const env: Record<string, string | undefined> = { ...process.env, NO_COLOR: '1', KORTIX_DISABLE_SANDBOX_ENV_FILE: '1', KORTIX_NO_UPDATE_CHECK: '1', KORTIX_CONFIG_FILE: join(cwd, 'config.json') };
    delete env.KORTIX_TOKEN;
    delete env.KORTIX_SESSION_ID;
    delete env.KORTIX_API_URL;
    return Bun.spawnSync([process.execPath, cli, 'validate', ...args], { cwd, env });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe('validate argument grammar', () => {
  test.each(['--jons', 'stray', '--no-dockerfile-lnit'])('rejects %s with usage', (arg) => {
    const result = validate([arg]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain(`unknown option "${arg}"`);
    expect(result.stderr.toString()).toContain('Usage: kortix validate');
    expect(result.stdout.toString()).toBe('');
  });

  test.each([[['--file']], [['--file', '--json']]])('requires a file value: %j', (args) => {
    const result = validate(args);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain('--file requires a value');
    expect(result.stderr.toString()).toContain('Usage: kortix validate');
    expect(result.stdout.toString()).toBe('');
  });

  test.each([[['--file', 'selected.yaml']], [['--file=selected.yaml']]])('accepts file syntax: %j', (args) => {
    const result = validate([...args, '--json', '--no-dockerfile-lint']);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toHaveProperty('valid', true);
    expect(result.stderr.toString()).not.toContain('Usage: kortix validate');
  });

  test.each(['--help', '-h'])('prints help for %s', (arg) => {
    const result = validate([arg]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('Usage: kortix validate');
    expect(result.stderr.toString()).not.toContain('Usage: kortix validate');
  });

  test('prints scopes without validating a file', () => {
    const result = validate(['--scopes']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('Grantable kortix_permissions');
    expect(result.stderr.toString()).not.toContain('Usage: kortix validate');
  });
});

describe('validate project tools', () => {
  function validateProject(files: Record<string, string>) {
    const cwd = mkdtempSync(join(tmpdir(), 'validate-tools-'));
    try {
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(cwd, path)), { recursive: true });
        writeFileSync(join(cwd, path), content);
      }
      const env: Record<string, string | undefined> = { ...process.env, NO_COLOR: '1', KORTIX_DISABLE_SANDBOX_ENV_FILE: '1', KORTIX_NO_UPDATE_CHECK: '1', KORTIX_CONFIG_FILE: join(cwd, 'config.json') };
      delete env.KORTIX_TOKEN;
      delete env.KORTIX_SESSION_ID;
      delete env.KORTIX_API_URL;
      const result = Bun.spawnSync([process.execPath, cli, 'validate', '--json', '--no-dockerfile-lint'], { cwd, env });
      return { exitCode: result.exitCode, report: JSON.parse(result.stdout.toString()) as { valid: boolean; issues: Array<{ path: string; message: string; severity: string }> } };
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
  const manifest = (tools: string, agentTools = '') =>
    `default_agent: kortix\nagents:\n  kortix:\n    mode: primary\n${agentTools}tools:\n${tools}`;

  test('a declared tool whose module exists, and an agent naming it, validate', () => {
    const result = validateProject({
      'kortix.yaml': manifest('  lookup_order: integrations/lookup.ts\n', '    tools: [read, lookup_order]\n'),
      'integrations/lookup.ts': 'export default {}\n',
    });
    expect(result.report.issues.filter((issue) => issue.path.includes('tools'))).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  test('a declared tool whose module is missing fails; a typo in an agent list fails', () => {
    const result = validateProject({
      'kortix.yaml': manifest('  lookup_order: tools/lookup.ts\n', '    tools: { exclude: [bassh] }\n'),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.report.issues.filter((issue) => issue.path.includes('tools'))).toEqual([
      expect.objectContaining({ path: 'agents.kortix.tools', message: expect.stringContaining('bassh'), severity: 'error', line: 5, column: 5 }),
      expect.objectContaining({ path: 'tools.lookup_order', message: '"tools/lookup.ts" does not exist in the project files.', severity: 'error', line: 7, column: 3 }),
    ]);
  });
});

describe('validate --fix', () => {
  test('a deprecated key warns, still validates, and --fix rewrites it in every imported file, comments kept', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'validate-fix-'));
    try {
      mkdirSync(join(cwd, 'team'));
      writeFileSync(join(cwd, 'kortix.yaml'), '# demo\nkortix_version: 3\nimports:\n  - team/agents.yaml\nproject:\n  name: fix-test\n');
      writeFileSync(join(cwd, 'team/agents.yaml'), 'agents:\n  worker:\n    prompt: Work.\n    tools: all\n    # keep the checkout\n    repository_access: true\n');
      const env: Record<string, string | undefined> = { ...process.env, NO_COLOR: '1', KORTIX_DISABLE_SANDBOX_ENV_FILE: '1', KORTIX_NO_UPDATE_CHECK: '1', KORTIX_CONFIG_FILE: join(cwd, 'config.json') };
      delete env.KORTIX_TOKEN;
      const run = (args: string[]) => Bun.spawnSync([process.execPath, cli, 'validate', '--no-dockerfile-lint', ...args], { cwd, env });

      const before = run(['--json']);
      expect(before.exitCode).toBe(0);
      const report = JSON.parse(before.stdout.toString()) as { issues: Array<{ path: string; fix?: string; line?: number; file: string }> };
      expect(report.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'kortix_version', fix: 'drop-kortix-version', line: 2 }),
        expect.objectContaining({ path: 'agents.worker.repository_access', fix: 'agent-repository-access', line: 6, file: join(cwd, 'team/agents.yaml') }),
      ]));

      const fixed = run(['--fix']);
      expect(fixed.exitCode).toBe(0);
      expect(fixed.stdout.toString()).toContain('team/agents.yaml: rewrote agents.worker.repository_access (agent-repository-access)');
      expect(readFileSync(join(cwd, 'kortix.yaml'), 'utf8')).toBe('# demo\nimports:\n  - team/agents.yaml\nproject:\n  name: fix-test\n');
      expect(readFileSync(join(cwd, 'team/agents.yaml'), 'utf8')).toContain('    # keep the checkout\n    workspace:\n      project_repository: true\n');
      expect(JSON.parse(run(['--json']).stdout.toString()).issues).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('a legacy format (kortix_version 2, kortix.toml)', () => {
  function project(files: Record<string, string>) {
    const cwd = mkdtempSync(join(tmpdir(), 'validate-legacy-'));
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), content);
    }
    const env: Record<string, string | undefined> = { ...process.env, NO_COLOR: '1', KORTIX_DISABLE_SANDBOX_ENV_FILE: '1', KORTIX_NO_UPDATE_CHECK: '1', KORTIX_CONFIG_FILE: join(cwd, 'config.json') };
    delete env.KORTIX_TOKEN;
    delete env.KORTIX_SESSION_ID;
    delete env.KORTIX_API_URL;
    const run = (args: string[]) => Bun.spawnSync([process.execPath, cli, ...args], { cwd, env });
    const read = (path: string) => readFileSync(join(cwd, path), 'utf8');
    const exists = (path: string) => Bun.file(join(cwd, path)).size > 0;
    return { cwd, run, read, exists, done: () => rmSync(cwd, { recursive: true, force: true }) };
  }
  type Report = { valid: boolean; issues: Array<{ path: string; severity: string; fix?: string; line?: number; message: string }> };

  const V2 = {
    'kortix.yaml': '# synthetic v2 project\nkortix_version: 2\ndefault_agent: lead\nopencode:\n  config_dir: harnesses/opencode\nagents:\n  lead:\n    file: agents/lead.md\n    connectors: all\n',
    'agents/lead.md': '---\ndescription: Leads the work.\nmode: primary\n---\n\nYou lead.\n',
    'harnesses/opencode/opencode.jsonc': '{ "permission": { "bash": "ask" } }\n',
  };

  test('kortix_version 2 validates with one warning, --fix converts the files, and the result has no issue', () => {
    const p = project(V2);
    try {
      const before = p.run(['validate', '--json', '--no-dockerfile-lint']);
      expect(before.exitCode).toBe(0);
      const report = JSON.parse(before.stdout.toString()) as Report;
      expect(report.valid).toBe(true);
      expect(report.issues).toEqual([expect.objectContaining({ path: 'kortix_version', severity: 'warning', fix: 'legacy-format', line: 2 })]);

      const fixed = p.run(['validate', '--fix', '--no-dockerfile-lint']);
      expect(fixed.exitCode).toBe(0);
      expect(fixed.stdout.toString()).toContain('kortix.yaml: converted to the current format');
      expect(fixed.stdout.toString()).toContain('deleted harnesses/opencode/opencode.jsonc');
      const manifest = p.read('kortix.yaml');
      expect(manifest).not.toContain('kortix_version');
      expect(manifest).toContain('prompt_file: agents/lead.md');
      expect(manifest).toContain('tools: all');
      expect(p.read('agents/lead.md')).toBe('You lead.\n');
      expect(p.exists('harnesses/opencode/opencode.jsonc')).toBe(false);
      expect((JSON.parse(p.run(['validate', '--json', '--no-dockerfile-lint']).stdout.toString()) as Report).issues).toEqual([]);
    } finally {
      p.done();
    }
  });

  test('a kortix.toml project is found, validates, and --fix replaces it with kortix.yaml', () => {
    const p = project({
      'kortix.toml': 'kortix_version = 1\n[project]\nname = "toml-test"\n\n[[agents]]\nname = "ops"\n',
      '.kortix/opencode/agents/ops.md': '---\nmode: primary\n---\nYou run ops.\n',
    });
    try {
      const report = JSON.parse(p.run(['validate', '--json', '--no-dockerfile-lint']).stdout.toString()) as Report;
      expect(report.valid).toBe(true);
      expect(report.issues[0]).toMatchObject({ path: 'kortix_version', fix: 'legacy-format', line: 1 });
      const fixed = p.run(['validate', '--fix', '--no-dockerfile-lint']);
      expect(fixed.exitCode).toBe(0);
      expect(fixed.stdout.toString()).toContain('kortix.toml: converted to kortix.yaml, the current format');
      expect(p.exists('kortix.toml')).toBe(false);
      expect(p.read('kortix.yaml')).toContain('name: toml-test');
      expect((JSON.parse(p.run(['validate', '--json', '--no-dockerfile-lint']).stdout.toString()) as Report).issues).toEqual([]);
    } finally {
      p.done();
    }
  });

  test('a v2 manifest split with imports: --fix converts each entry in the file that declares it', () => {
    const p = project({
      'kortix.yaml': 'kortix_version: 2\nimports:\n  - team/agents.yaml\nproject:\n  name: split\n',
      'team/agents.yaml': 'agents:\n  worker:\n    prompt: Work.\n    repository_access: false\n',
    });
    try {
      expect(p.run(['validate', '--fix', '--no-dockerfile-lint']).exitCode).toBe(0);
      expect(p.read('kortix.yaml')).toContain('imports:\n  - team/agents.yaml\n');
      expect(p.read('kortix.yaml')).not.toContain('worker');
      expect(p.read('team/agents.yaml')).toContain('workspace:\n      project_repository: false\n');
      expect((JSON.parse(p.run(['validate', '--json', '--no-dockerfile-lint']).stdout.toString()) as Report).issues).toEqual([]);
    } finally {
      p.done();
    }
  });

  test('a CLI write refuses a legacy file and leaves it unchanged', () => {
    const p = project(V2);
    try {
      const result = p.run(['triggers', 'add', 'nightly', '--cron', '0 0 3 * * *', '--prompt', 'Review.']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain('Run `kortix validate --fix` to convert it');
      expect(p.read('kortix.yaml')).toBe(V2['kortix.yaml']);
    } finally {
      p.done();
    }
  });
});
