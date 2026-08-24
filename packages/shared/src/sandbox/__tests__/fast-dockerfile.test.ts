import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { buildFastSandboxDockerfile } from '../fast-dockerfile';

const DEFAULT_OPTIONS = {
  agentBinaryPath: 'artifacts/kortix-agent.gz',
  cliBinaryPath: 'artifacts/kortix.gz',
  entrypointScriptPath: 'artifacts/kortix-entrypoint',
  opencodeWarmupScriptPath: 'artifacts/opencode-warmup',
  machineDocPath: 'artifacts/MACHINE.fast.md',
  slackCliPath: 'artifacts/slack-cli',
  lazyToolsPath: 'artifacts/lazy-tools',
  catalogPath: 'artifacts/llm-catalog.json',
  managedSkillsPath: 'artifacts/managed-skills',
  runtimeVersionsPath: 'artifacts/runtime-versions.json',
  opencodeConfigPath: 'artifacts/opencode',
  scaffoldPath: 'artifacts/scaffold.git',
};

describe('buildFastSandboxDockerfile', () => {
  test('keeps the session-critical runtime and defers heavyweight tool packs', () => {
    const dockerfile = buildFastSandboxDockerfile(DEFAULT_OPTIONS);

expect(dockerfile).toContain('FROM ubuntu:24.04');
    expect(dockerfile).toContain('opencode-ai@1.18.19');
    expect(dockerfile).toContain(
      "opencode_native=\"$(sed -n 's/^# cmd-shim-target=//p' \"$(command -v opencode)\" | tail -n 1)\"",
    );
    expect(dockerfile).not.toContain('pnpm list -g');
    expect(dockerfile).not.toContain('pnpm root -g');
    expect(dockerfile).toContain('test "$(wc -c < "$opencode_native")" -gt 50000000');
    expect(dockerfile).toContain('ln -sfn "$opencode_native" /opt/kortix/opencode.current');
    expect(dockerfile).toContain(
      'ln -sfn /opt/kortix/opencode.current /usr/local/bin/opencode-kortix',
    );
    expect(dockerfile).toContain('pnpm-linux-${pnpm_arch}.tar.gz');
    expect(dockerfile).toContain('bun-v1.3.14');
    expect(dockerfile).toContain('aarch64|arm64) bun_arch=aarch64');
    expect(dockerfile).toContain('uv-${uv_arch}-unknown-linux-gnu.tar.gz');
    expect(dockerfile).toContain('/usr/local/bin/kortix-agent');
    expect(dockerfile).toContain('/usr/local/bin/kortix');
    expect(dockerfile).toContain('/opt/kortix/scaffold.git');
    expect(dockerfile).toContain('/opt/kortix/opencode-config-deps');
    expect(dockerfile).toContain(
      'COPY --chown=kortix:kortix artifacts/opencode/package.json artifacts/opencode/bun.lock /opt/kortix/opencode-config-deps/',
    );
    expect(dockerfile).toContain('/home/kortix/.bun/bin/bun install --frozen-lockfile');
    expect(dockerfile).toContain('COPY --chown=kortix:kortix artifacts/opencode-warmup');
    expect(dockerfile).toContain('bash /tmp/kortix-opencode-warmup migration');
    expect(dockerfile).toContain('/opt/kortix/warm-config/.kortix/opencode/');
    expect(dockerfile).toContain(
      '/home/kortix/.bun/bin/bun build tools/*.ts --target=bun --outdir=/tmp/opencode-tools-bundle-check',
    );
    expect(dockerfile).toContain('git clone -q /opt/kortix/scaffold.git /workspace');
    expect(dockerfile).toContain('kortixOpenCodeInstallSentinel');
    expect(dockerfile).toContain('bash /tmp/kortix-opencode-warmup instance keep');
    expect(dockerfile.indexOf('/opt/kortix/scaffold.git')).toBeLessThan(
      dockerfile.indexOf('instance keep'),
    );
    expect(dockerfile.indexOf('git clone -q /opt/kortix/scaffold.git /workspace')).toBeLessThan(
      dockerfile.indexOf('instance keep'),
    );
    expect(dockerfile.indexOf('kortixOpenCodeInstallSentinel')).toBeLessThan(
      dockerfile.indexOf('instance keep'),
    );
    expect(dockerfile).toContain(
      'sudo -u kortix env HOME=/home/kortix git -C /workspace status',
    );
    expect(dockerfile.indexOf('bun build tools/*.ts')).toBeGreaterThan(
      dockerfile.indexOf('/opt/kortix/warm-config/.kortix/opencode/'),
    );
    expect(dockerfile.indexOf('instance keep')).toBeGreaterThan(
      dockerfile.indexOf('bun build tools/*.ts'),
    );
    expect(dockerfile.indexOf('instance keep')).toBeGreaterThan(
      dockerfile.indexOf('/opt/kortix/warm-config/.kortix/opencode/'),
    );
    expect(dockerfile).toContain('/opt/kortix/runtime-versions.json');
    expect(dockerfile).toContain('/ephemeral/kortix-master/opencode');
    expect(dockerfile).toContain('/opt/kortix/lazy-tools/install');
    expect(dockerfile).toContain('make gcc g++ cc c++ pkg-config');
    expect(dockerfile).toContain('/opt/pw-browsers');
    expect(dockerfile).toContain('KORTIX_RUNTIME_PROFILE=fast');
    expect(dockerfile).toContain('KORTIX_PROJECT_AUTO_CLONE=1');
    expect(dockerfile).toContain('AGENT_BROWSER_EXECUTABLE_PATH=/home/kortix/.local/bin/chromium');

    expect(dockerfile).not.toContain('apt-get install -y --no-install-recommends libreoffice');
    expect(dockerfile).not.toContain('texlive-latex-extra');
    expect(dockerfile).not.toContain('playwright install --with-deps chromium');
    expect(dockerfile).not.toContain('uv pip install --python');
  });

  test('uses valid lazy-tool runtime paths', () => {
    const installer = readFileSync(
      new URL('../../../../../apps/sandbox/lazy-tools/install', import.meta.url),
      'utf8',
    );

    expect(installer).toContain('exec /home/kortix/.local/share/pnpm/bin/agent-browser "$@"');
    expect(installer).toContain('uv venv --python "${python_bin}" "${python_env}"');
    expect(installer).toContain(
      'uv pip install --python "${python_env}/bin/python" "${python_specs[@]}"',
    );
  });

  test('installs only the lean OpenCode config runtime', () => {
    const dockerfile = buildFastSandboxDockerfile(DEFAULT_OPTIONS);

    expect(dockerfile).toContain('test -d node_modules/zod');
    expect(dockerfile).toContain('test ! -e node_modules/@opencode-ai/plugin');
    expect(dockerfile).toContain('test ! -e node_modules/effect');
    expect(dockerfile).toContain('test ! -e node_modules/@mendable/firecrawl-js');
    expect(dockerfile).toContain('test ! -e node_modules/@tavily/core');
    expect(dockerfile).toContain('test ! -e node_modules/replicate');
    expect(dockerfile).not.toContain('bun build node_modules/axios');
  });
});
