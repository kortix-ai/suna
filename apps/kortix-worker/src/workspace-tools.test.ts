import { afterEach, describe, expect, test } from 'bun:test';
import { exec } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KortixExecutionEnv } from './kortix-env.ts';
import { startWorker } from './worker.ts';
import { createWorkspaceTools } from './workspace-tools.ts';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function execute(command: string, cwd: string, path: string) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
    exec(command, { cwd, env: { ...process.env, PATH: path } }, (error, stdout, stderr) => {
      resolve({
        stdout,
        stderr,
        exitCode: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
      });
    });
  });
}

async function remoteEnvironment() {
  const root = mkdtempSync(join(tmpdir(), 'kortix-tool-environment-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.ts'), "export const source = 'remote-only';\n");
  writeFileSync(join(root, 'src', 'app.test.ts'), "test('remote-only', () => {});\n");
  writeFileSync(join(root, 'src', 'long.ts'), `long-match ${'x'.repeat(600)}\n`);
  writeFileSync(join(root, 'docs', 'note.md'), 'remote-only\n');
  writeFileSync(join(root, '.git', 'secret.ts'), 'remote-only\n');
  const ripgrep = join(root, 'bin', 'rg');
  writeFileSync(
    ripgrep,
    `#!${process.execPath}
const { readFileSync } = require('node:fs');
const args = process.argv.slice(2);
const separator = args.indexOf('--');
const pattern = args[separator + 1];
if (args.includes('--files')) {
  const glob = args[args.lastIndexOf('--glob') + 1];
  if (glob === 'src/**/*.ts') process.stdout.write('src/app.test.ts\\nsrc/app.ts\\n');
  process.exit(0);
}
let found = false;
for (const file of ['src/app.test.ts', 'src/app.ts', 'src/long.ts']) {
  const lines = readFileSync(file, 'utf8').trimEnd().split('\\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].includes(pattern)) {
      found = true;
      process.stdout.write(file + ':' + (index + 1) + ':' + lines[index] + '\\n');
    }
  }
}
if (!found) process.exit(1);
`,
  );
  chmodSync(ripgrep, 0o755);
  const remotePath = `${join(root, 'bin')}:${process.env.PATH ?? ''}`;

  const calls: Array<{ op: string; args: Record<string, unknown>; cwd?: string }> = [];
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', async () => {
      const parsed = JSON.parse(body) as {
        op: string;
        args: Record<string, unknown>;
        cwd?: string;
      };
      calls.push(parsed);
      if (parsed.op !== 'exec' || typeof parsed.args.command !== 'string') {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error: { code: 'EINVAL', message: 'exec required' } }));
        return;
      }
      const value = await execute(parsed.args.command, root, remotePath);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, value }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  cleanups.push(() => server.close());
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));

  const env = new KortixExecutionEnv({
    baseUrl: `http://127.0.0.1:${port}`,
    cwd: '/workspace',
    transport: 'fetch',
  });
  return { calls, env, root, url: `http://127.0.0.1:${port}` };
}

function text(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content.map((part) => part.text ?? '').join('');
}

describe('workspace tools', () => {
  test('registers the complete dedicated tool surface', async () => {
    const { env } = await remoteEnvironment();

    expect(createWorkspaceTools(env).map((tool) => tool.name)).toEqual([
      'bash',
      'read',
      'write',
      'edit',
      'glob',
      'grep',
    ]);
  });

  test('glob and grep execute through the remote environment', async () => {
    const { calls, env } = await remoteEnvironment();
    const tools = createWorkspaceTools(env);
    const glob = tools.find((tool) => tool.name === 'glob')!;
    const grep = tools.find((tool) => tool.name === 'grep')!;

    const globResult = await glob.execute('glob-call', { pattern: 'src/**/*.ts' });
    const grepResult = await grep.execute('grep-call', {
      pattern: 'remote-only',
      path: 'src',
      include: '*.ts',
    });

    expect(text(globResult)).toBe('src/app.test.ts\nsrc/app.ts');
    expect(text(grepResult)).toBe(
      "src/app.test.ts:1:test('remote-only', () => {});\nsrc/app.ts:1:export const source = 'remote-only';",
    );
    expect(calls.map((call) => call.op)).toEqual(['exec', 'exec']);
    expect(calls.map((call) => call.args.cwd)).toEqual(['/workspace', '/workspace']);
    expect(calls.every((call) => !String(call.args.command).includes(process.cwd()))).toBe(true);
  });

  test('quotes search input instead of executing it as shell syntax', async () => {
    const { env, root } = await remoteEnvironment();
    const tools = createWorkspaceTools(env);
    const glob = tools.find((tool) => tool.name === 'glob')!;
    const grep = tools.find((tool) => tool.name === 'grep')!;

    const globResult = await glob.execute('glob-call', {
      pattern: "*.ts'; touch glob-injected; printf '",
    });
    const grepResult = await grep.execute('grep-call', {
      pattern: "'; touch grep-injected; #",
    });

    expect(text(globResult)).toBe('No files found');
    expect(text(grepResult)).toBe('No matches found');
    expect(existsSync(join(root, 'glob-injected'))).toBe(false);
    expect(existsSync(join(root, 'grep-injected'))).toBe(false);
  });

  test('grep truncates an oversized matching line', async () => {
    const { env } = await remoteEnvironment();
    const grep = createWorkspaceTools(env).find((tool) => tool.name === 'grep')!;

    const result = await grep.execute('grep-call', {
      pattern: 'long-match',
      path: 'src',
      include: '*.ts',
    });

    expect(text(result)).toContain('[truncated]');
    expect(text(result)).toContain('[Truncated 1 matching line to 500 characters.]');
    expect((result.details as { truncatedLines?: number }).truncatedLines).toBe(1);
  });

  test('the worker agent invokes glob and grep through its registered surface', async () => {
    const { calls, url } = await remoteEnvironment();
    const worker = await startWorker({
      port: 0,
      envUrl: url,
      envUrlExplicit: true,
      envCwd: '/workspace',
      envTransport: 'fetch',
      systemPrompt: 'Use the requested tools.',
      modelMode: 'faux',
      sessionId: 'workspace-tool-test',
    });

    try {
      const response = await fetch(`http://127.0.0.1:${worker.port}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: 'Inspect the workspace.',
          script: [
            { tool: 'glob', args: { pattern: 'src/**/*.ts' } },
            { tool: 'grep', args: { pattern: 'remote-only', path: 'src', include: '*.ts' } },
            { text: 'done' },
          ],
        }),
      });
      const body = await response.json() as { ok: boolean; rpcCalls: string[] };

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.rpcCalls).toEqual(['exec', 'exec']);
      expect(calls.map((call) => call.op)).toEqual(['exec', 'exec']);
    } finally {
      await worker.close();
    }
  });
});
