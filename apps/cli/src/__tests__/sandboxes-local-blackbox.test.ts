/**
 * Black-box coverage for the pre-push gate: `kortix validate`'s Dockerfile lint
 * and `kortix sandboxes build --local`.
 *
 * NOTHING here talks to a real Docker daemon (no test in this repo does, and a
 * test that pulls ubuntu:24.04 and runs apt for 20 minutes would be a test
 * nobody runs). Instead PATH is pointed at a stub `docker` that records every
 * invocation — which lets us assert the stronger property anyway: that `--print`
 * never invokes it at all.
 */
import { chmodSync, mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

const CLI_ENTRY = join(resolve(import.meta.dir, '..', '..'), 'src', 'index.ts');
const SANDBOX_ENV_OVERRIDES = [
  'KORTIX_API_URL',
  'KORTIX_CLI_TOKEN',
  'KORTIX_EXECUTOR_TOKEN',
  'KORTIX_FRONTEND_URL',
  'KORTIX_PROJECT_ID',
  'KORTIX_TOKEN',
  'BASH_ENV',
] as const;

let tmp: string;
/** Written by the stub docker on every call — its existence means Docker was touched. */
let dockerLog: string;

/** A minimal manifest that PASSES the schema, so any error is the lint's. */
const MANIFEST = (extra: string) =>
  [
    'kortix_version: 2',
    'default_agent: kortix',
    'project:',
    '  name: fixture',
    'agents:',
    '  kortix: {}',
    extra,
    '',
  ].join('\n');

async function runCli(args: string[], cwd = tmp) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    KORTIX_NO_UPDATE_CHECK: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    // Stub docker first on PATH: nothing in this suite may reach a real daemon.
    PATH: `${join(tmp, 'bin')}:${process.env.PATH}`,
  };
  for (const key of SANDBOX_ENV_OVERRIDES) delete env[key];
  const proc = Bun.spawn({ cmd: [process.execPath, CLI_ENTRY, ...args], cwd, env, stdout: 'pipe', stderr: 'pipe' });
  const timeout = setTimeout(() => proc.kill(), 20_000);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => clearTimeout(timeout));
  return { code, stdout, stderr };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'kortix-local-build-'));
  mkdirSync(join(tmp, 'bin'));
  dockerLog = join(tmp, 'docker-was-called');
  writeFileSync(
    join(tmp, 'bin', 'docker'),
    `#!/bin/sh\necho "$@" >> "${dockerLog}"\nexit 0\n`,
    'utf8',
  );
  chmodSync(join(tmp, 'bin', 'docker'), 0o755);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('kortix sandboxes build --local --print', () => {
  beforeEach(() => {
    writeFileSync(
      join(tmp, 'kortix.yaml'),
      MANIFEST('sandbox:\n  templates:\n    - slug: ml\n      dockerfile: Dockerfile.ml'),
      'utf8',
    );
    writeFileSync(join(tmp, 'Dockerfile.ml'), 'FROM ubuntu:24.04\nRUN echo hello\n', 'utf8');
  });

  test('prints the composed Dockerfile, exits 0, and never touches Docker', async () => {
    const r = await runCli(['sandboxes', 'build', '--local', '--print']);
    expect(r.code).toBe(0);
    // The user's Dockerfile, verbatim and first.
    expect(r.stdout.startsWith('FROM ubuntu:24.04\nRUN echo hello\n')).toBe(true);
    // The Kortix toolchain layer, including the pip floor.
    expect(r.stdout).toContain('Kortix runtime layer (auto-injected)');
    expect(r.stdout).toContain('/opt/kortix/pyfloor/bin/pip install');
    // …but not the artifact tail.
    expect(r.stdout).not.toContain('scaffold.git');
    expect(r.stdout).not.toContain('ENTRYPOINT');
    // No preamble noise — the output must be pipeable into `docker build -`.
    expect(r.stdout).not.toContain('Building ml');
    expect(existsSync(dockerLog)).toBe(false);
  });

  test('resolves the sole declared template without a slug, and honors an explicit one', async () => {
    const bare = await runCli(['sandboxes', 'build', '--local', '--print']);
    const named = await runCli(['sandboxes', 'build', '--local', 'ml', '--print']);
    expect(named.code).toBe(0);
    expect(named.stdout).toBe(bare.stdout);
  });

  test('--no-layer prints the user Dockerfile alone', async () => {
    const r = await runCli(['sandboxes', 'build', '--local', '--print', '--no-layer']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('FROM ubuntu:24.04\nRUN echo hello\n');
    expect(existsSync(dockerLog)).toBe(false);
  });

  test('an unknown slug exits 2 listing the declared slugs, without building', async () => {
    const r = await runCli(['sandboxes', 'build', '--local', 'nope', '--print']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('nope');
    expect(r.stderr).toContain('ml');
    expect(existsSync(dockerLog)).toBe(false);
  });

  test('--platform\'s value is not mistaken for a slug', async () => {
    // `positional[0]` is only meaningful after the flag takers have mutated argv.
    const r = await runCli(['sandboxes', 'build', '--local', '--platform', 'linux/amd64', '--print']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('FROM ubuntu:24.04');
  });

  test('--local on a cloud subcommand errors instead of silently doing the cloud thing', async () => {
    const r = await runCli(['sandboxes', 'rebuild', 'ml', '--local']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--local only applies');
    expect(existsSync(dockerLog)).toBe(false);
  });

  test('needs no login — the whole point of a pre-push gate', async () => {
    // runCli strips every KORTIX_* credential and there's no config.json in tmp,
    // so this asserts the command routes above resolveProjectContext.
    const r = await runCli(['sandboxes', 'build', '--local', '--print']);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain('Not logged in');
  });
});

describe('kortix sandboxes --help', () => {
  test('renders the local build section', async () => {
    const r = await runCli(['sandboxes', '--help']);
    expect(r.code).toBe(0);
    for (const fragment of [
      'build --local [slug]',
      'Local build',
      '--platform <p>',
      '--no-layer',
      '--print',
      'kortix-local/<slug>:latest',
    ]) {
      expect(r.stdout).toContain(fragment);
    }
  });
});

describe('kortix validate — sandbox Dockerfile lint', () => {
  beforeEach(() => {
    writeFileSync(
      join(tmp, 'kortix.yaml'),
      MANIFEST('sandbox:\n  templates:\n    - slug: ml\n      dockerfile: Dockerfile.ml'),
      'utf8',
    );
    // Incident (a): the repo is never in the build context.
    writeFileSync(
      join(tmp, 'Dockerfile.ml'),
      'FROM ubuntu:24.04\nCOPY requirements-kortix.txt ./\n',
      'utf8',
    );
  });

  test('a template Dockerfile that COPYs a repo file fails validate, naming the file', async () => {
    const r = await runCli(['validate']);
    expect(r.code).not.toBe(0);
    const all = r.stdout + r.stderr;
    expect(all).toContain('requirements-kortix.txt');
    expect(all).toContain('Dockerfile.ml');
  });

  test('--no-dockerfile-lint passes (the manifest itself is fine)', async () => {
    const r = await runCli(['validate', '--no-dockerfile-lint']);
    expect(r.code).toBe(0);
  });

  test('--json carries the Dockerfile issue in the same issues array', async () => {
    const r = await runCli(['validate', '--json']);
    expect(r.code).toBe(1);
    const report = JSON.parse(r.stdout);
    expect(report.valid).toBe(false);
    const hit = report.issues.find((i: { path: string }) => i.path === 'Dockerfile.ml');
    expect(hit.severity).toBe('error');
    expect(hit.message).toContain('requirements-kortix.txt');
    expect(hit.line).toBe(2);
  });

  test('a clean Dockerfile validates', async () => {
    writeFileSync(join(tmp, 'Dockerfile.ml'), 'FROM ubuntu:24.04\nRUN echo hi\n', 'utf8');
    const r = await runCli(['validate']);
    expect(r.code).toBe(0);
  });

  test('a missing Dockerfile is left to the manifest validator, not double-reported', async () => {
    rmSync(join(tmp, 'Dockerfile.ml'));
    const r = await runCli(['validate']);
    expect(r.stdout + r.stderr).not.toContain('build context');
  });
});
