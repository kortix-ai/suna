/**
 * The login-shell hook every layered image and the meta image bake.
 *
 * The web terminal spawns `/bin/bash -l` (kortix-sandbox-agent-server
 * routes/pty.ts). A login shell sources /etc/profile, and Debian's /etc/profile
 * resets PATH for every non-root user to `/usr/local/bin:/usr/bin:/bin:…`. The
 * Kortix tool directories (pnpm-global `opencode`, uv's Python, bun) then drop
 * off PATH in the terminal, while the agent's non-login `bash -c` keeps them.
 * Ubuntu's /etc/profile leaves PATH alone, so the default image never showed it.
 *
 * These tests execute the rendered hook with a real `sh`, not only read it.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import {
  KORTIX_AGENT_ENV_FILE,
  KORTIX_SHELL_PROFILE_PATH,
  KORTIX_USER_PATH_DIRS,
  buildLayeredDockerfile,
  kortixShellProfileRun,
  kortixShellProfileScript,
  kortixToolchainLayer,
} from '../dockerfile-layer';
import { buildMetaSandboxDockerfile } from '../meta-dockerfile';

const KORTIX_DIRS = KORTIX_USER_PATH_DIRS.split(':');
const DEBIAN_USER_PATH = '/usr/local/bin:/usr/bin:/bin:/usr/local/games:/usr/games';
const DEBIAN_ROOT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

const workDir = mkdtempSync(join(tmpdir(), 'kortix-shell-profile-'));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

/** Source the hook (optionally twice) in a POSIX `sh` and print the resulting PATH. */
function pathAfterHook(startPath: string | null, opts: { times?: number; envFile?: string } = {}) {
  const script = kortixShellProfileScript().replaceAll(
    KORTIX_AGENT_ENV_FILE,
    opts.envFile ?? join(workDir, 'absent-agent-env.sh'),
  );
  const hook = join(workDir, `hook-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(hook, script);
  const sources = Array.from({ length: opts.times ?? 1 }, () => `. ${hook}`).join('; ');
  const env: Record<string, string> = {};
  const setPath = startPath === null ? 'unset PATH' : `PATH='${startPath}'`;
  const proc = spawnSync('/bin/sh', ['-c', `${setPath}; ${sources}; printf '%s|%s' "$PATH" "\${KORTIX_TEST_SECRET-}"`], {
    env,
    encoding: 'utf8',
  });
  expect(proc.stderr).toBe('');
  expect(proc.status).toBe(0);
  const [path, secret] = proc.stdout.split('|');
  return { path: path!, secret: secret! };
}

describe('the shell profile hook restores the Kortix tool directories', () => {
  test('prepends every Kortix dir after Debian resets PATH for a non-root login shell', () => {
    expect(pathAfterHook(DEBIAN_USER_PATH).path).toBe(`${KORTIX_USER_PATH_DIRS}:${DEBIAN_USER_PATH}`);
  });

  test('keeps the root sbin dirs Debian sets for root', () => {
    expect(pathAfterHook(DEBIAN_ROOT_PATH).path).toBe(`${KORTIX_USER_PATH_DIRS}:${DEBIAN_ROOT_PATH}`);
  });

  test('leaves PATH byte-identical when the daemon PATH survived (Ubuntu)', () => {
    const daemonPath = `${KORTIX_USER_PATH_DIRS}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
    expect(pathAfterHook(daemonPath).path).toBe(daemonPath);
  });

  test('is idempotent when sourced more than once', () => {
    expect(pathAfterHook(DEBIAN_USER_PATH, { times: 3 }).path).toBe(
      `${KORTIX_USER_PATH_DIRS}:${DEBIAN_USER_PATH}`,
    );
  });

  test('adds only the missing dirs and keeps the existing order', () => {
    const partial = `/usr/bin:${KORTIX_DIRS[1]}:/bin`;
    const missing = KORTIX_DIRS.filter((d) => d !== KORTIX_DIRS[1]).join(':');
    expect(pathAfterHook(partial).path).toBe(`${missing}:${partial}`);
  });

  test('never adds an empty PATH entry (the current directory) when PATH is empty or unset', () => {
    expect(pathAfterHook('').path).toBe(KORTIX_USER_PATH_DIRS);
    expect(pathAfterHook(null).path).toBe(KORTIX_USER_PATH_DIRS);
  });

  test('sources the live agent env file when it is readable', () => {
    const envFile = join(workDir, 'agent-env.sh');
    writeFileSync(envFile, "export KORTIX_TEST_SECRET='loaded'\n");
    expect(pathAfterHook(DEBIAN_USER_PATH, { envFile }).secret).toBe('loaded');
    expect(pathAfterHook(DEBIAN_USER_PATH).secret).toBe('');
  });

  test('leaks no helper variables into the shell', () => {
    const hook = join(workDir, 'hook-vars.sh');
    writeFileSync(hook, kortixShellProfileScript());
    const proc = spawnSync('/bin/sh', ['-c', `. ${hook}; set | grep -c '^kortix_' || true`], {
      env: { PATH: DEBIAN_USER_PATH },
      encoding: 'utf8',
    });
    expect(proc.stdout.trim()).toBe('0');
  });

  test('reads the same agent env file the daemon writes', () => {
    const daemonSource = readFileSync(
      resolve(import.meta.dir, '../../../../../apps/kortix-sandbox-agent-server/src/agent-env-file.ts'),
      'utf8',
    );
    const dir = /export const AGENT_ENV_DIR = '([^']+)'/.exec(daemonSource)?.[1];
    expect(`${dir}/agent-env.sh`).toBe(KORTIX_AGENT_ENV_FILE);
  });
});

describe('the Dockerfile step that installs the hook', () => {
  const run = kortixShellProfileRun();

  test('writes the hook into /etc/profile.d and wires /etc/bash.bashrc idempotently', () => {
    expect(KORTIX_SHELL_PROFILE_PATH).toMatch(/^\/etc\/profile\.d\/[^/]+\.sh$/);
    expect(run).toContain(`> ${KORTIX_SHELL_PROFILE_PATH}`);
    expect(run).toContain(`chmod 0644 ${KORTIX_SHELL_PROFILE_PATH}`);
    expect(run).toContain('/etc/bash.bashrc');
    expect(run).toContain('grep -qxF');
  });

  test('uses only constructs every provider builder parses (no heredoc, no backslash escapes)', () => {
    expect(run).not.toMatch(/<</);
    expect(run).not.toContain('printf');
    for (const line of kortixShellProfileScript().split('\n')) {
      expect(line).not.toContain('\\');
      expect(line).not.toContain("'");
    }
  });

  test('renders the file the Dockerfile writes byte-for-byte', () => {
    // Execute the RUN step's shell (minus the leading `RUN`) against a scratch
    // root and compare the produced file with the renderer's script.
    const root = join(workDir, 'root');
    const shell = run
      .replace(/^RUN /, '')
      .replace(/\\\n/g, '')
      .replaceAll(`> ${KORTIX_SHELL_PROFILE_PATH}`, `> ${root}${KORTIX_SHELL_PROFILE_PATH}`)
      .replaceAll(`chmod 0644 ${KORTIX_SHELL_PROFILE_PATH}`, `chmod 0644 ${root}${KORTIX_SHELL_PROFILE_PATH}`)
      .replaceAll('/etc/bash.bashrc', `${root}/etc/bash.bashrc`);
    const proc = spawnSync('/bin/sh', ['-c', `mkdir -p ${root}/etc/profile.d && ${shell}\n${shell}`], {
      encoding: 'utf8',
    });
    expect(proc.stderr).toBe('');
    expect(proc.status).toBe(0);
    const written = readFileSync(`${root}${KORTIX_SHELL_PROFILE_PATH}`, 'utf8');
    expect(written).toBe(kortixShellProfileScript());
    const bashrc = readFileSync(`${root}/etc/bash.bashrc`, 'utf8');
    // Running the step twice appends the bashrc hook exactly once.
    expect(bashrc.split('\n').filter((l) => l.includes(KORTIX_SHELL_PROFILE_PATH))).toHaveLength(1);
  });

  test('the hook is valid POSIX sh and valid bash', () => {
    const hook = join(workDir, 'hook-syntax.sh');
    writeFileSync(hook, kortixShellProfileScript());
    expect(spawnSync('/bin/sh', ['-n', hook]).status).toBe(0);
    expect(spawnSync('bash', ['-n', hook]).status).toBe(0);
  });
});

describe('every image that runs the web terminal bakes the hook as root', () => {
  test('the layered image writes it after the last USER root and before the final USER kortix', () => {
    const image = buildLayeredDockerfile({
      userDockerfile: 'FROM debian:bookworm-slim\n',
      opencodeVersion: '0.0.0',
      agentBinaryPath: 'kortix-agent.gz',
      cliBinaryPath: 'kortix.gz',
      entrypointScriptPath: 'kortix-entrypoint',
      machineDocPath: 'MACHINE.md',
      slackCliPath: 'kortix-slack-cli',
    });
    const at = image.indexOf(kortixShellProfileRun());
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(image.lastIndexOf('USER root'));
    expect(at).toBeLessThan(image.lastIndexOf('USER kortix'));
  });

  test('the toolchain-only render (local `kortix sandboxes build`) does not need it', () => {
    expect(kortixToolchainLayer({ opencodeVersion: '0.0.0' })).not.toContain(KORTIX_SHELL_PROFILE_PATH);
  });

  test('the meta image (debian:bookworm-slim) writes it before its entrypoint', () => {
    const meta = buildMetaSandboxDockerfile({
      agentBinaryPath: 'kortix-agent.gz',
      cliBinaryPath: 'kortix.gz',
      entrypointScriptPath: 'kortix-entrypoint',
      catalogPath: 'llm-catalog.json',
      managedSkillsPath: 'managed-skills',
    });
    const at = meta.indexOf(kortixShellProfileRun());
    expect(at).toBeGreaterThan(-1);
    expect(meta).not.toMatch(/^USER /m);
    expect(at).toBeLessThan(meta.indexOf('ENTRYPOINT'));
  });
});
