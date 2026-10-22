import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const cli = join(import.meta.dir, '../index.ts');

function validate(args: string[]) {
  const cwd = mkdtempSync(join(tmpdir(), 'validate-argv-'));
  try {
    writeFileSync(join(cwd, 'kortix.yaml'), 'invalid: true\n');
    writeFileSync(join(cwd, 'selected.yaml'), 'kortix_version: 1\nproject:\n  name: argv-test\n');
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
    `kortix_version: 2\ndefault_agent: kortix\nagents:\n  kortix:\n    file: agents/kortix.md\n${agentTools}tools:\n${tools}`;

  test('a declared tool whose module exists, and an agent naming it, validate', () => {
    const result = validateProject({
      'kortix.yaml': manifest('  web_search: kortix:web_search\n  lookup_order: integrations/lookup.ts\n', '    tools: [read, lookup_order]\n'),
      'agents/kortix.md': '---\ndescription: d\n---\nPrompt.\n',
      'integrations/lookup.ts': 'export default {}\n',
    });
    expect(result.report.issues.filter((issue) => issue.path.includes('tools'))).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  test('a declared tool whose module is missing fails; a typo in an agent list warns', () => {
    const result = validateProject({
      'kortix.yaml': manifest('  web_search: kortix:web_search\n  lookup_order: tools/lookup.ts\n', '    tools: { exclude: [bassh] }\n'),
      'agents/kortix.md': '---\ndescription: d\n---\nPrompt.\n',
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.report.issues.filter((issue) => issue.path.includes('tools'))).toEqual([
      { path: 'agents.kortix.tools', message: expect.stringContaining('"bassh"'), severity: 'warning' },
      { path: 'tools.lookup_order', message: '"tools/lookup.ts" does not exist in the project files.', severity: 'error' },
    ]);
  });
});
