import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, writeFileSync, chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CLI_ALLOWED, DENY_COMMANDS, DENY_SUBCOMMANDS, MAX_CONCURRENT, cliEnv, denial, parseArgs, resolveCli, runCli } from './cli';

const base = { token: 'kortix_pat_secret', apiUrl: 'http://127.0.0.1:8008/v1', timeoutMs: 10_000 };
/** A stand-in CLI: a shell script that prints what the real one would receive. */
function fakeCli(body: string): string[][] {
  const path = join(mkdtempSync(join(tmpdir(), 'fake-cli-')), 'kortix');
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return [[path]];
}

describe('cliEnv', () => {
  test('is exactly the allowed key set and never process.env', () => {
    process.env.SECRET_SERVER_KEY = 'must-not-leak';
    const env = cliEnv({ ...base, home: '/h', tmp: '/t' });
    expect(Object.keys(env).sort()).toEqual(['CI', 'HOME', 'KORTIX_API_URL', 'KORTIX_DISABLE_SANDBOX_ENV_FILE', 'KORTIX_NO_UPDATE_CHECK', 'KORTIX_TOKEN', 'NO_COLOR', 'PATH', 'TMPDIR']);
    expect(env.KORTIX_TOKEN).toBe('kortix_pat_secret');
    expect(JSON.stringify(env)).not.toContain('must-not-leak');
    const scoped = cliEnv({ ...base, home: '/h', tmp: '/t', projectId: 'p', sessionId: 's' });
    expect(scoped.KORTIX_PROJECT_ID).toBe('p');
    expect(scoped.KORTIX_SESSION_ID).toBe('s');
  });
});

describe('denial', () => {
  test.each([
    [['--host', 'x', 'whoami']],
    [['whoami', '--host=evil']],
    [['hosts', 'ls']],
    [['login']],
    [['logout']],
    [['init']],
    [['ship']],
    [['update']],
    [['uninstall']],
    [['self-host', 'start']],
    [['tui']],
    [['t']],
    [['connect']],
    [['chat']],
    [['sessions', 'chat', 'abc']],
    [['token']],
    [['whoami', '--token-only']],
    [['env', 'pull']],
    [['env', 'push']],
    [['apps', 'deploy', './x']],
    [['backends', 'deploy', 'main', '--dir', '.']],
    [['backends', 'env', 'main']],
    [['backends', 'token', 'main']],
    [['connectors', 'mcp']],
    [['sessions', 'shell', 'abc']],
  ])('%j is refused with a reason and an alternative', (args) => {
    const d = denial(args);
    expect(d?.reason.length).toBeGreaterThan(5);
    expect(d?.use.length).toBeGreaterThan(3);
  });

  test('apps deploy names run_command in a session sandbox', () => {
    expect(denial(['apps', 'deploy'])?.use).toContain('run_command in a session sandbox');
  });

  test('backends list and create run; deploy and env point at a session sandbox', () => {
    expect(denial(['backends', 'list'])).toBeNull();
    expect(denial(['backends', 'create', 'main'])).toBeNull();
    expect(denial(['backends', 'deploy', 'main'])?.use).toContain('run_command in a session sandbox');
    expect(denial(['backends', 'env', 'main'])?.reason).toContain('admin key');
  });

  test.each([
    [['secrets', 'ls', '--json']],
    [['chat', 'abc', '--prompt', 'hi']],
    [['sessions', 'chat', '-p', 'hi']],
    [['apps', 'ls']],
    [['env', 'ls']],
    [['--help']],
    [['whoami', '--json']],
  ])('%j runs', (args) => expect(denial(args)).toBeNull());

  test('a prototype key is not a command', () => {
    expect(denial(['constructor'])?.reason).toContain('not a kortix command');
    expect(denial(['__proto__'])?.reason).toContain('not a kortix command');
  });

  test('a leading flag or unknown word never reaches the CLI: only a known command may lead', () => {
    expect(denial(['--project', '00000000-0000-4000-a000-000000000000', 'update'])?.reason).toContain('not a kortix command');
    expect(denial(['-p', 'x', 'login'])?.reason).toContain('not a kortix command');
    expect(denial(['nope'])?.reason).toContain('not a kortix command');
  });

  test('every top-level command of the CLI is either denied or allowed: a new command needs a decision', () => {
    const source = readFileSync(join(import.meta.dir, '../../../cli/src/index.ts'), 'utf8');
    // KRTX-1341 replaced the KNOWN_COMMANDS literal with one handler record;
    // the suggestion list derives from its keys plus the two landing verbs.
    const block = /const COMMAND_HANDLERS: Record<string, RootCommandHandler> = \{([\s\S]*?)\n\};/.exec(
      source,
    )?.[1];
    expect(block).toBeDefined();
    const keys = [...(block!.matchAll(/^ {2}(?:'([^']+)'|([a-z][a-z0-9]*)):/gm))].map(
      (m) => m[1] ?? m[2],
    );
    const commands = [...keys, 'help', 'version'].filter((c): c is string => typeof c === 'string');
    expect(commands.length).toBeGreaterThan(40);
    const decided = new Set([...Object.keys(DENY_COMMANDS), ...CLI_ALLOWED]);
    expect(commands.filter((c) => !decided.has(c))).toEqual([]);
    // No stale decisions for commands the CLI dropped.
    expect([...decided].filter((c) => !commands.includes(c))).toEqual([]);
    // A command is decided once.
    expect(Object.keys(DENY_COMMANDS).filter((c) => CLI_ALLOWED.includes(c))).toEqual([]);
    expect(DENY_SUBCOMMANDS.every((d) => CLI_ALLOWED.includes(d.path[0]))).toBe(true);
  });
});

describe('parseArgs', () => {
  test('accepts a string array, refuses everything else', () => {
    expect(parseArgs(['secrets', 'ls'])).toEqual(['secrets', 'ls']);
    for (const bad of [undefined, 'secrets ls', [], [1], ['a\0b'], Array(65).fill('x')]) expect(typeof parseArgs(bad)).toBe('string');
  });
});

describe('runCli', () => {
  test('spawns the argv without a shell: metacharacters arrive as literal arguments', async () => {
    const r = await runCli({ ...base, args: ['whoami', 'a; touch /tmp/kortix-mcp-pwned', '$(id)', '`id`'], cli: fakeCli('for a in "$@"; do echo "[$a]"; done') });
    expect(r.ok).toBe(true);
    const out = JSON.parse((r as { json: string }).json);
    expect(out.stdout).toBe('[whoami]\n[a; touch /tmp/kortix-mcp-pwned]\n[$(id)]\n[`id`]\n');
    expect(existsSync('/tmp/kortix-mcp-pwned')).toBe(false);
  });

  test('the child sees only the clean env, an empty cwd and a fresh HOME; both are removed afterwards', async () => {
    process.env.SECRET_SERVER_KEY = 'must-not-leak';
    const r = await runCli({ ...base, args: ['whoami'], projectId: 'p1', cli: fakeCli('env | sort; echo "cwd=$(pwd)"; echo "files=$(ls -A | wc -l)"') });
    const out = JSON.parse((r as { json: string }).json);
    const lines: string[] = out.stdout.split('\n');
    expect(out.stdout).not.toContain('must-not-leak');
    const keys = lines.filter((l) => /^[A-Z_]+=/.test(l) && !l.startsWith('cwd=')).map((l) => l.split('=')[0]!).filter((k) => k !== 'PWD' && k !== 'SHLVL' && k !== '_' && k !== 'OLDPWD');
    expect(keys.sort()).toEqual(['CI', 'HOME', 'KORTIX_API_URL', 'KORTIX_DISABLE_SANDBOX_ENV_FILE', 'KORTIX_NO_UPDATE_CHECK', 'KORTIX_PROJECT_ID', 'KORTIX_TOKEN', 'NO_COLOR', 'PATH', 'TMPDIR']);
    expect(out.stdout).toMatch(/files=\s*0\n/);
    const cwd = lines.find((l) => l.startsWith('cwd='))!.slice(4);
    expect(existsSync(cwd)).toBe(false);
    expect(readdirSync(tmpdir()).filter((d) => d.startsWith('kortix-mcp-') && cwd.includes(d))).toEqual([]);
  });

  test('a denied command never spawns', async () => {
    const marker = join(mkdtempSync(join(tmpdir(), 'marker-')), 'ran');
    const r = await runCli({ ...base, args: ['--host', 'x', 'whoami'], cli: fakeCli(`touch ${marker}`) });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain('Refused');
    expect(existsSync(marker)).toBe(false);
  });

  test('a command that runs too long is killed and says so', async () => {
    const started = Date.now();
    const r = await runCli({ ...base, args: ['whoami'], timeoutMs: 300, cli: fakeCli('sleep 30') });
    const out = JSON.parse((r as { json: string }).json);
    expect(out.timed_out).toContain('killed');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test('--json output comes back as a JSON value, a large one too; a cut one stays a string with the note', async () => {
    const big = JSON.stringify({ accounts: Array.from({ length: 800 }, (_, i) => ({ id: `acct-${i}`, name: `"quoted" ${i}` })) });
    expect(big.length).toBeGreaterThan(24_000);
    const r = await runCli({ ...base, args: ['whoami', '--json'], cli: fakeCli(`printf '%s' '${big}'`) });
    const out = JSON.parse((r as { json: string }).json);
    expect(out.json.accounts).toHaveLength(800);
    expect(out.stdout).toBeUndefined();
    expect(out.truncated).toBeUndefined();
    const huge = await runCli({ ...base, args: ['whoami', '--json'], cli: fakeCli(`printf '[' ; head -c 200000 /dev/zero | tr '\\0' '1'; printf ']'`) });
    const cut = JSON.parse((huge as { json: string }).json);
    expect(cut.json).toBeUndefined();
    expect(cut.truncated).toContain('not valid JSON');
  });

  test('output over the cap is cut with a note and the reply stays valid JSON', async () => {
    const r = await runCli({ ...base, args: ['whoami'], cli: fakeCli(`head -c 500000 /dev/zero | tr '\\0' '"'`) });
    const json = (r as { json: string }).json;
    expect(json.length).toBeLessThan(56_000);
    const out = JSON.parse(json);
    expect(out.truncated).toContain('output cut');
    expect(out.exit_code).toBe(0);
  });

  test('at most MAX_CONCURRENT children run at once; the next call is told to retry', async () => {
    const slow = fakeCli('sleep 1');
    const first = Array.from({ length: MAX_CONCURRENT }, () => runCli({ ...base, args: ['whoami'], cli: slow }));
    const extra = await runCli({ ...base, args: ['whoami'], cli: slow });
    expect(extra).toMatchObject({ ok: false });
    expect((extra as { error: string }).error).toContain('Busy');
    for (const r of await Promise.all(first)) expect(r.ok).toBe(true);
    expect((await runCli({ ...base, args: ['whoami'], cli: slow })).ok).toBe(true);
  });

  test('a binary that cannot run falls through to the next candidate', async () => {
    const broken = join(mkdtempSync(join(tmpdir(), 'broken-cli-')), 'kortix');
    writeFileSync(broken, 'not an executable', { mode: 0o755 });
    const r = await runCli({ ...base, args: ['whoami'], cli: [[broken], ...fakeCli('echo ok')] });
    expect(JSON.parse((r as { json: string }).json).stdout).toBe('ok\n');
    const none = await runCli({ ...base, args: ['whoami'], cli: [[broken]] });
    expect((none as { error: string }).error).toContain('CLI not available');
  });

  test('no CLI on the server is an answer, not a crash', async () => {
    const r = await runCli({ ...base, args: ['whoami'], cli: [] });
    expect((r as { error: string }).error).toContain('CLI not available');
    expect(resolveCli('/nonexistent-root', '/bin/bun')).toEqual([]);
  });
});
