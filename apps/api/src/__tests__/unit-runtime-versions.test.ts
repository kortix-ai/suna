import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AGENT_BROWSER_VERSION,
  ANYDOC_VERSION,
  BUN_SHA256_AMD64,
  BUN_SHA256_ARM64,
  BUN_VERSION,
  CLAUDE_CODE_SHA256_AMD64,
  CLAUDE_CODE_SHA256_ARM64,
  CLAUDE_CODE_VERSION,
  CODEX_CLI_SHA256_AMD64,
  CODEX_CLI_SHA256_ARM64,
  CODEX_CLI_VERSION,
  OPENCODE_SDK_VERSION,
  OPENCODE_USER_AGENT,
  OPENCODE_VERSION,
  PLAYWRIGHT_VERSION,
  PNPM_SHA256_AMD64,
  PNPM_SHA256_ARM64,
  UV_SHA256_AMD64,
  UV_SHA256_ARM64,
} from '@kortix/shared';
import { CODEX_USER_AGENT } from '../llm-gateway/credentials/codex-core';
import {
  PLATFORM_DEFAULT_USER_DOCKERFILE,
  buildLayeredDockerfile,
} from '../snapshots/dockerfile-layer';

const repoRoot = resolve(import.meta.dir, '../../../..');

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

describe('runtime version drift guards', () => {
  test('SDK package and lockfile use the canonical OpenCode SDK pin', () => {
    const sdkPackage = JSON.parse(readRepoFile('packages/sdk/package.json')) as {
      dependencies?: Record<string, string>;
    };
    expect(sdkPackage.dependencies?.['@opencode-ai/sdk']).toBe(OPENCODE_SDK_VERSION);

    const lockfile = readRepoFile('pnpm-lock.yaml');
    expect(lockfile).toContain(`'@opencode-ai/sdk':`);
    expect(lockfile).toContain(`specifier: ${OPENCODE_SDK_VERSION}`);
    expect(lockfile).toContain(`/@opencode-ai/sdk@${OPENCODE_SDK_VERSION}:`);
  });

  test('sandbox Dockerfile reads runtime pins from the shared manifest', () => {
    const dockerfile = readRepoFile('apps/sandbox/Dockerfile');
    expect(dockerfile).toContain('COPY packages/shared/src/runtime-versions.json');
    expect(dockerfile).toContain("require('/tmp/kortix-runtime-versions.json').opencode");
    expect(dockerfile).toContain("require('/tmp/kortix-runtime-versions.json').agentBrowser");
    expect(dockerfile).toContain("require('/tmp/kortix-runtime-versions.json').playwright");
    expect(dockerfile).toContain("require('/tmp/kortix-runtime-versions.json').bun");
    expect(dockerfile).toContain("require('/tmp/kortix-runtime-versions.json').anydoc");
    expect(dockerfile).toContain("require('/tmp/kortix-runtime-versions.json').codexCli");
    expect(dockerfile).toContain("require('/tmp/kortix-runtime-versions.json').claudeCode");
    expect(dockerfile).toContain(
      'codex-${CODEX_CLI_VERSION}-linux-${cli_arch}.tgz',
    );
    expect(dockerfile).toContain(
      'claude-code-linux-${cli_arch}-${CLAUDE_CODE_VERSION}.tgz',
    );
    expect(dockerfile).toContain('codexCliSha256Amd64');
    expect(dockerfile).toContain('codexCliSha256Arm64');
    expect(dockerfile).toContain('claudeCodeSha256Amd64');
    expect(dockerfile).toContain('claudeCodeSha256Arm64');
    expect(dockerfile).toContain(`test "$(codex --version)" = "codex-cli \${CODEX_CLI_VERSION}"`);
    expect(dockerfile).toContain(
      `test "$(claude --version)" = "\${CLAUDE_CODE_VERSION} (Claude Code)"`,
    );
    expect(dockerfile).toContain('DISABLE_UPDATES=1');
    expect(dockerfile.indexOf('codex-${CODEX_CLI_VERSION}')).toBeLessThan(
      dockerfile.indexOf('opencode-ai@${OPENCODE_VERSION}'),
    );
    expect(dockerfile).toContain('pnpmSha256Amd64');
    expect(dockerfile).toContain('pnpmSha256Arm64');
    expect(dockerfile).toContain('uvSha256Amd64');
    expect(dockerfile).toContain('uvSha256Arm64');
    expect(dockerfile).toContain('bunSha256Amd64');
    expect(dockerfile).toContain('bunSha256Arm64');
    expect(
      dockerfile.match(
        /FROM oven\/bun:1\.3\.14-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f/g,
      ),
    ).toHaveLength(2);
    expect(dockerfile).not.toContain('FROM oven/bun:1-debian');
    expect(dockerfile).not.toContain('get.pnpm.io/install.sh');
    expect(dockerfile).not.toContain('curl -LsSf "https://astral.sh/uv/');
    expect(dockerfile).not.toContain('https://bun.com/install');
    expect(dockerfile).not.toMatch(/ARG OPENCODE_VERSION=/);
    expect(dockerfile).not.toMatch(/ARG AGENT_BROWSER_VERSION=/);
    expect(dockerfile).not.toMatch(/ARG PLAYWRIGHT_VERSION=/);
  });

  test('generated snapshot Dockerfile uses canonical runtime pins', () => {
    const merged = buildLayeredDockerfile({
      userDockerfile: PLATFORM_DEFAULT_USER_DOCKERFILE,
      opencodeVersion: OPENCODE_VERSION,
      agentBrowserVersion: AGENT_BROWSER_VERSION,
      agentBinaryPath: 'kortix-agent.gz',
      cliBinaryPath: 'kortix.gz',
      entrypointScriptPath: 'kortix-entrypoint',
      machineDocPath: 'MACHINE.md',
      slackCliPath: 'kortix-slack-cli',
    });

    expect(merged).toContain(`opencode-ai@${OPENCODE_VERSION}`);
    expect(merged).toContain(`agent-browser@${AGENT_BROWSER_VERSION}`);
    expect(merged).toContain(`@firecrawl/anydoc@${ANYDOC_VERSION}`);
    expect(merged).toContain(`codex-${CODEX_CLI_VERSION}-linux-\${cli_arch}.tgz`);
    expect(merged).toContain(
      `claude-code-linux-\${cli_arch}-${CLAUDE_CODE_VERSION}.tgz`,
    );
    expect(merged).toContain(`test "$(codex --version)" = "codex-cli ${CODEX_CLI_VERSION}"`);
    expect(merged).toContain(
      `test "$(claude --version)" = "${CLAUDE_CODE_VERSION} (Claude Code)"`,
    );
    expect(merged).toContain(`playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium`);
    expect(merged).toContain(BUN_VERSION);
    for (const digest of [
      PNPM_SHA256_AMD64,
      PNPM_SHA256_ARM64,
      UV_SHA256_AMD64,
      UV_SHA256_ARM64,
      BUN_SHA256_AMD64,
      BUN_SHA256_ARM64,
      CODEX_CLI_SHA256_AMD64,
      CODEX_CLI_SHA256_ARM64,
      CLAUDE_CODE_SHA256_AMD64,
      CLAUDE_CODE_SHA256_ARM64,
    ]) {
      expect(merged).toContain(digest);
    }
  });

  test('Codex/OpenAI OAuth traffic presents the same OpenCode user-agent pin', () => {
    expect(CODEX_USER_AGENT).toBe(OPENCODE_USER_AGENT);
  });
});
