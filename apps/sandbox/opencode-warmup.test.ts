import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(import.meta.dir, 'opencode-warmup.sh');

let fixtureRoot: string;
let fixtureBin: string;

function writeExecutable(name: string, source: string): void {
  const path = join(fixtureBin, name);
  writeFileSync(path, source, 'utf8');
  chmodSync(path, 0o755);
}

async function runWarmup(mode: string, env: Record<string, string> = {}, cleanup?: string) {
  const proc = Bun.spawn({
    cmd: ['bash', SCRIPT, mode, ...(cleanup ? [cleanup] : [])],
    env: {
      ...process.env,
      HOME: join(fixtureRoot, 'home'),
      PATH: `${fixtureBin}:${process.env.PATH ?? ''}`,
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync({
    cmd: ['git', ...args],
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  return result.stdout.toString().trim();
}

function processIsExecuting(pid: number): boolean {
  const result = Bun.spawnSync({
    cmd: ['ps', '-o', 'stat=', '-p', String(pid)],
    stdout: 'pipe',
    stderr: 'ignore',
  });
  if (result.exitCode !== 0) return false;
  const state = result.stdout.toString().trim();
  return state.length > 0 && !state.startsWith('Z');
}

describe('opencode image warm-up', () => {
  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'kortix-opencode-warmup-'));
    fixtureBin = join(fixtureRoot, 'bin');
    mkdirSync(fixtureBin, { recursive: true });
    writeExecutable(
      'opencode',
      `#!/usr/bin/env bash
if [ "\${FAKE_OPENCODE_CRASH:-0}" = "1" ]; then
  exit 7
fi
if [ "\${FAKE_OPENCODE_IGNORE_TERM:-0}" = "1" ]; then
  trap '' TERM INT
else
  trap 'exit 0' TERM INT
fi
if [ -n "\${FAKE_OPENCODE_PID_FILE:-}" ]; then
  printf '%s' "$$" >"$FAKE_OPENCODE_PID_FILE"
fi
if [ -n "\${FAKE_OPENCODE_HELPER_PID_FILE:-}" ]; then
  (
    trap '' TERM INT
    printf '%s' "$BASHPID" >"$FAKE_OPENCODE_HELPER_PID_FILE"
    while :; do /bin/sleep 0.05; done
  ) &
fi
requested_port=""
previous=""
for argument in "$@"; do
  if [ "$previous" = "--port" ]; then
    requested_port="$argument"
  fi
  previous="$argument"
done
if [ -n "\${FAKE_OPENCODE_REQUESTED_PORT_CAPTURE_FILE:-}" ]; then
  printf '%s' "$requested_port" >"$FAKE_OPENCODE_REQUESTED_PORT_CAPTURE_FILE"
fi
if [ -n "$requested_port" ]; then
  printf 'opencode server listening on http://127.0.0.1:%s\n' \
    "\${FAKE_OPENCODE_LISTEN_PORT:-$requested_port}"
fi
if [ -n "\${FAKE_OPENCODE_CONFIG_CAPTURE_FILE:-}" ]; then
  printf '%s' "\${OPENCODE_CONFIG_DIR:-}" >"$FAKE_OPENCODE_CONFIG_CAPTURE_FILE"
fi
if [ -n "\${FAKE_OPENCODE_PROJECT_CONFIG_DISABLE_CAPTURE_FILE:-}" ]; then
  printf '%s' "\${OPENCODE_DISABLE_PROJECT_CONFIG:-}" >"$FAKE_OPENCODE_PROJECT_CONFIG_DISABLE_CAPTURE_FILE"
fi
if [ -n "\${FAKE_OPENCODE_REPO_CONFIG_PATH:-}" ] && [ -e "$FAKE_OPENCODE_REPO_CONFIG_PATH" ]; then
  : >"$FAKE_OPENCODE_REPO_CONFIG_LOADED_FILE"
fi
if [ -n "\${OPENCODE_CONFIG_DIR:-}" ] && [ -e "$OPENCODE_CONFIG_DIR/malicious-plugin.ts" ]; then
  : >"$FAKE_OPENCODE_REPO_CONFIG_LOADED_FILE"
fi
if [ "\${OPENCODE_DISABLE_PROJECT_CONFIG:-}" != "1" ]; then
  if [ -n "\${FAKE_OPENCODE_ROOT_JSON_PATH:-}" ] && [ -e "$FAKE_OPENCODE_ROOT_JSON_PATH" ]; then
    : >"$FAKE_OPENCODE_ROOT_JSON_LOADED_FILE"
  fi
  if [ -n "\${FAKE_OPENCODE_ROOT_JSONC_PATH:-}" ] && [ -e "$FAKE_OPENCODE_ROOT_JSONC_PATH" ]; then
    : >"$FAKE_OPENCODE_ROOT_JSONC_LOADED_FILE"
  fi
  if [ -n "\${FAKE_OPENCODE_PROJECT_PLUGIN_PATH:-}" ] && [ -e "$FAKE_OPENCODE_PROJECT_PLUGIN_PATH" ]; then
    : >"$FAKE_OPENCODE_PROJECT_PLUGIN_LOADED_FILE"
  fi
fi
if [ -n "\${FAKE_OPENCODE_MUTATE_WORKSPACE:-}" ]; then
  printf 'mutated tracked\n' >"$FAKE_OPENCODE_MUTATE_WORKSPACE/tracked.txt"
  chmod 0600 "$FAKE_OPENCODE_MUTATE_WORKSPACE/tracked.txt"
  printf 'generated\n' >"$FAKE_OPENCODE_MUTATE_WORKSPACE/generated.txt"
  mkdir -p "$FAKE_OPENCODE_MUTATE_WORKSPACE/ignored-dir"
  printf 'ignored\n' >"$FAKE_OPENCODE_MUTATE_WORKSPACE/ignored-dir/cache.txt"
fi
if [ -n "\${FAKE_OPENCODE_READY_FILE:-}" ]; then
  : >"$FAKE_OPENCODE_READY_FILE"
fi
while :; do /bin/sleep 0.05; done
`,
    );
    writeExecutable(
      'setsid',
      `#!/usr/bin/env python3
import os
import sys
os.setsid()
os.execvp(sys.argv[1], sys.argv[1:])
`,
    );
    writeExecutable(
      'curl',
      `#!/usr/bin/env bash
for argument in "$@"; do
  case "$argument" in
    http://*|https://*) request_url="$argument" ;;
  esac
done
if [ -n "\${FAKE_CURL_URL_CAPTURE_FILE:-}" ]; then
  printf '%s' "\${request_url:-}" >"$FAKE_CURL_URL_CAPTURE_FILE"
fi
if [ "\${FAKE_CURL_READY:-0}" = "1" ]; then
  if [ -n "\${FAKE_OPENCODE_READY_FILE:-}" ] && [ ! -f "$FAKE_OPENCODE_READY_FILE" ]; then
    printf '000'
    exit 1
  fi
  printf '%s' "\${FAKE_CURL_CODE:-200}"
  exit 0
fi
printf '000'
exit 1
`,
    );
    writeExecutable('sleep', '#!/usr/bin/env bash\nexit 0\n');
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  test('returns success only after OpenCode responds', async () => {
    const disableCaptureFile = join(fixtureRoot, 'project-config-disabled');
    const readyFile = join(fixtureRoot, 'opencode.ready');
    const result = await runWarmup('migration', {
      FAKE_CURL_READY: '1',
      FAKE_OPENCODE_READY_FILE: readyFile,
      FAKE_OPENCODE_PROJECT_CONFIG_DISABLE_CAPTURE_FILE: disableCaptureFile,
      OPENCODE_DISABLE_PROJECT_CONFIG: '',
    });
    expect(result.code).toBe(0);
    expect(readFileSync(disableCaptureFile, 'utf8')).toBe('');
  });

  test('uses a provider-assigned port so concurrent image builds cannot collide', async () => {
    const portCaptureFile = join(fixtureRoot, 'requested-port');
    const urlCaptureFile = join(fixtureRoot, 'readiness-url');
    const readyFile = join(fixtureRoot, 'opencode.ready');
    const result = await runWarmup('migration', {
      FAKE_CURL_READY: '1',
      FAKE_CURL_URL_CAPTURE_FILE: urlCaptureFile,
      FAKE_OPENCODE_READY_FILE: readyFile,
      FAKE_OPENCODE_REQUESTED_PORT_CAPTURE_FILE: portCaptureFile,
    });

    expect(result.code).toBe(0);
    const requestedPort = readFileSync(portCaptureFile, 'utf8');
    expect(Number(requestedPort)).toBeGreaterThan(0);
    expect(requestedPort).not.toBe('4096');
    expect(readFileSync(urlCaptureFile, 'utf8')).toContain(
      `http://127.0.0.1:${requestedPort}/session?`,
    );
  });

  test('fails when OpenCode exits before readiness', async () => {
    const result = await runWarmup('migration', { FAKE_OPENCODE_CRASH: '1' });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('did not become ready');
  });

  test('force-kills the warm-up process group after the shutdown deadline', async () => {
    const pidFile = join(fixtureRoot, 'opencode.pid');
    const helperPidFile = join(fixtureRoot, 'opencode-helper.pid');
    const readyFile = join(fixtureRoot, 'opencode.ready');
    const result = await runWarmup('migration', {
      FAKE_CURL_READY: '1',
      FAKE_OPENCODE_IGNORE_TERM: '1',
      FAKE_OPENCODE_PID_FILE: pidFile,
      FAKE_OPENCODE_HELPER_PID_FILE: helperPidFile,
      FAKE_OPENCODE_READY_FILE: readyFile,
      OPENCODE_WARMUP_STOP_ATTEMPTS: '2',
      OPENCODE_WARMUP_STOP_POLL_SECONDS: '0.01',
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('forcing process group shutdown');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    const helperPid = Number(readFileSync(helperPidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(processIsExecuting(helperPid)).toBe(false);
  });

  test.each(['absent-default-config', 'empty-default-config', 'custom-config'])(
    'repo cleanup restores exact Git state for %s',
    async (layout) => {
      const workspace = join(fixtureRoot, 'workspace');
      const warmConfig = join(fixtureRoot, 'warm-config');
      const configDeps = join(fixtureRoot, 'config-deps', 'node_modules');
      mkdirSync(workspace, { recursive: true });
      mkdirSync(join(warmConfig, '.kortix', 'opencode'), { recursive: true });
      mkdirSync(configDeps, { recursive: true });
      writeFileSync(join(warmConfig, '.kortix', 'opencode', 'opencode.json'), '{}\n');
      git(workspace, 'init', '-b', 'main');
      writeFileSync(join(workspace, 'tracked.txt'), 'original tracked\n');
      chmodSync(join(workspace, 'tracked.txt'), 0o755);
      writeFileSync(join(workspace, '.gitignore'), 'ignored-dir/\n');
      if (layout === 'empty-default-config') {
        mkdirSync(join(workspace, '.kortix', 'opencode'), { recursive: true });
        writeFileSync(join(workspace, '.kortix', 'opencode', '.keep'), 'keep\n');
      }
      if (layout === 'custom-config') {
        mkdirSync(join(workspace, '.kortix', 'custom'), { recursive: true });
        writeFileSync(join(workspace, '.kortix', 'custom', 'opencode.json'), '{}\n');
      }
      git(workspace, 'add', '-A');
      git(
        workspace,
        '-c',
        'user.email=test@kortix.dev',
        '-c',
        'user.name=Kortix Test',
        'commit',
        '-m',
        'base',
      );
      const head = git(workspace, 'rev-parse', 'HEAD');

      const result = await runWarmup(
        'instance',
        {
          FAKE_CURL_READY: '1',
          FAKE_OPENCODE_MUTATE_WORKSPACE: workspace,
          KORTIX_WARMUP_WORKSPACE: workspace,
          KORTIX_WARMUP_CONFIG_ROOT: warmConfig,
          KORTIX_WARMUP_CONFIG_DEPS: join(fixtureRoot, 'config-deps', 'node_modules'),
        },
        'repo',
      );

      expect(result.code).toBe(0);
      expect(git(workspace, 'rev-parse', 'HEAD')).toBe(head);
      expect(git(workspace, 'status', '--porcelain=v1', '--untracked-files=all')).toBe('');
      expect(git(workspace, 'clean', '-ndx')).toBe('');
      expect(readFileSync(join(workspace, 'tracked.txt'), 'utf8')).toBe('original tracked\n');
      expect(statSync(join(workspace, 'tracked.txt')).mode & 0o777).toBe(0o755);
      expect(existsSync(join(workspace, 'generated.txt'))).toBe(false);
      expect(existsSync(join(workspace, 'ignored-dir'))).toBe(false);
      expect(existsSync(join(workspace, '.kortix', 'opencode', 'node_modules'))).toBe(false);
      expect(existsSync(join(workspace, '.kortix', 'custom', 'opencode.json'))).toBe(
        layout === 'custom-config',
      );
    },
  );

  test('repo cleanup rejects a dirty baked checkout before warming it', async () => {
    const workspace = join(fixtureRoot, 'workspace');
    const warmConfig = join(fixtureRoot, 'warm-config');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(warmConfig, '.kortix', 'opencode'), { recursive: true });
    writeFileSync(join(warmConfig, '.kortix', 'opencode', 'opencode.json'), '{}\n');
    git(workspace, 'init', '-b', 'main');
    writeFileSync(join(workspace, 'tracked.txt'), 'original\n');
    git(workspace, 'add', '-A');
    git(
      workspace,
      '-c',
      'user.email=test@kortix.dev',
      '-c',
      'user.name=Kortix Test',
      'commit',
      '-m',
      'base',
    );
    writeFileSync(join(workspace, 'tracked.txt'), 'must survive\n');

    const result = await runWarmup(
      'instance',
      {
        FAKE_CURL_READY: '1',
        KORTIX_WARMUP_WORKSPACE: workspace,
        KORTIX_WARMUP_CONFIG_ROOT: warmConfig,
      },
      'repo',
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('requires a pristine baked checkout');
    expect(readFileSync(join(workspace, 'tracked.txt'), 'utf8')).toBe('must survive\n');
  });

  test('repo warm-up indexes the checkout with only the canonical OpenCode config', async () => {
    const workspace = join(fixtureRoot, 'workspace');
    const warmConfig = join(fixtureRoot, 'warm-config');
    const configDeps = join(fixtureRoot, 'config-deps', 'node_modules');
    const captureFile = join(fixtureRoot, 'config-path');
    const disableCaptureFile = join(fixtureRoot, 'project-config-disabled');
    const loadedFile = join(fixtureRoot, 'malicious-loaded');
    const rootJsonLoadedFile = join(fixtureRoot, 'root-json-loaded');
    const rootJsoncLoadedFile = join(fixtureRoot, 'root-jsonc-loaded');
    const projectPluginLoadedFile = join(fixtureRoot, 'project-plugin-loaded');
    const readyFile = join(fixtureRoot, 'opencode.ready');
    const repoConfig = join(workspace, '.kortix', 'opencode');
    const canonicalConfig = join(warmConfig, '.kortix', 'opencode');
    const rootJson = join(workspace, 'opencode.json');
    const rootJsonc = join(workspace, 'opencode.jsonc');
    const projectPlugin = join(workspace, '.opencode', 'plugin', 'malicious.ts');
    mkdirSync(repoConfig, { recursive: true });
    mkdirSync(canonicalConfig, { recursive: true });
    mkdirSync(configDeps, { recursive: true });
    writeFileSync(
      join(repoConfig, 'opencode.json'),
      '{"plugin":["./malicious-plugin.ts"],"tools":{"malicious":true}}\n',
    );
    writeFileSync(join(repoConfig, 'malicious-plugin.ts'), 'throw new Error("loaded")\n');
    mkdirSync(join(repoConfig, 'tools'), { recursive: true });
    writeFileSync(join(repoConfig, 'tools', 'malicious.ts'), 'throw new Error("loaded")\n');
    writeFileSync(rootJson, '{"plugin":["./root-json-plugin.ts"]}\n');
    writeFileSync(rootJsonc, '{"plugin":["./root-jsonc-plugin.ts"]}\n');
    mkdirSync(join(workspace, '.opencode', 'plugin'), { recursive: true });
    writeFileSync(projectPlugin, 'throw new Error("loaded")\n');
    writeFileSync(join(canonicalConfig, 'opencode.json'), '{}\n');
    git(workspace, 'init', '-b', 'main');
    git(workspace, 'add', '-A');
    git(
      workspace,
      '-c',
      'user.email=test@kortix.dev',
      '-c',
      'user.name=Kortix Test',
      'commit',
      '-m',
      'base',
    );
    const head = git(workspace, 'rev-parse', 'HEAD');
    const refs = git(workspace, 'show-ref');

    const result = await runWarmup(
      'instance',
      {
        FAKE_CURL_READY: '1',
        FAKE_OPENCODE_READY_FILE: readyFile,
        FAKE_OPENCODE_CONFIG_CAPTURE_FILE: captureFile,
        FAKE_OPENCODE_PROJECT_CONFIG_DISABLE_CAPTURE_FILE: disableCaptureFile,
        FAKE_OPENCODE_REPO_CONFIG_PATH: repoConfig,
        FAKE_OPENCODE_REPO_CONFIG_LOADED_FILE: loadedFile,
        FAKE_OPENCODE_ROOT_JSON_PATH: rootJson,
        FAKE_OPENCODE_ROOT_JSON_LOADED_FILE: rootJsonLoadedFile,
        FAKE_OPENCODE_ROOT_JSONC_PATH: rootJsonc,
        FAKE_OPENCODE_ROOT_JSONC_LOADED_FILE: rootJsoncLoadedFile,
        FAKE_OPENCODE_PROJECT_PLUGIN_PATH: projectPlugin,
        FAKE_OPENCODE_PROJECT_PLUGIN_LOADED_FILE: projectPluginLoadedFile,
        KORTIX_WARMUP_WORKSPACE: workspace,
        KORTIX_WARMUP_CONFIG_ROOT: warmConfig,
        KORTIX_WARMUP_CONFIG_DEPS: configDeps,
      },
      'repo',
    );

    expect(result.code).toBe(0);
    expect(readFileSync(captureFile, 'utf8')).toBe(canonicalConfig);
    expect(readFileSync(disableCaptureFile, 'utf8')).toBe('1');
    expect(existsSync(loadedFile)).toBe(false);
    expect(existsSync(rootJsonLoadedFile)).toBe(false);
    expect(existsSync(rootJsoncLoadedFile)).toBe(false);
    expect(existsSync(projectPluginLoadedFile)).toBe(false);
    expect(readFileSync(join(repoConfig, 'opencode.json'), 'utf8')).toContain('malicious-plugin.ts');
    expect(readFileSync(join(repoConfig, 'malicious-plugin.ts'), 'utf8')).toContain('loaded');
    expect(readFileSync(join(repoConfig, 'tools', 'malicious.ts'), 'utf8')).toContain('loaded');
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(workspace, 'show-ref')).toBe(refs);
    expect(git(workspace, 'status', '--porcelain=v1', '--untracked-files=all')).toBe('');
    expect(git(workspace, 'clean', '-ndx')).toBe('');
  });

  test('rejects an unknown warm-up mode', async () => {
    const result = await runWarmup('invalid');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('usage:');
  });

  test('the standalone image links the native executable for the supervisor', () => {
    const dockerfile = readFileSync(resolve(import.meta.dir, 'Dockerfile'), 'utf8');

    expect(dockerfile).toContain('iputils-arping util-linux');
    expect(dockerfile).toContain(
      'opencode_package="$(pnpm root -g)/opencode-ai"',
    );
    expect(dockerfile).toContain('opencode_native="$opencode_package/bin/opencode.exe"');
    expect(dockerfile).toContain('test "$(wc -c < "$opencode_native")" -gt 50000000');
    expect(dockerfile).toContain('ln -sfn "$opencode_native" /opt/kortix/opencode.current');
    expect(dockerfile).toContain(
      'sudo ln -sfn /opt/kortix/opencode.current /usr/local/bin/opencode-kortix',
    );
  });
});
