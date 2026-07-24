import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AGENT_BROWSER_VERSION,
  OPENCODE_USER_AGENT,
  OPENCODE_VERSION,
  PLAYWRIGHT_VERSION,
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
  test('host applications and the Kortix SDK do not depend on the native OpenCode SDK', () => {
    const packagePaths = [
      'apps/web/package.json',
      'apps/mobile/package.json',
      'apps/whitelabel-demo/package.json',
      'packages/sdk/package.json',
    ];

    for (const packagePath of packagePaths) {
      const pkg = JSON.parse(readRepoFile(packagePath)) as {
        devDependencies?: Record<string, string>;
        dependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      expect(pkg.dependencies?.['@opencode-ai/sdk'] ?? null).toBeNull();
      expect(pkg.devDependencies?.['@opencode-ai/sdk'] ?? null).toBeNull();
      expect(pkg.peerDependencies?.['@opencode-ai/sdk'] ?? null).toBeNull();
    }
  });

  test('sandbox Dockerfile reads runtime pins from the shared manifest', () => {
    const dockerfile = readRepoFile('apps/sandbox/Dockerfile');
    expect(dockerfile).toContain('COPY packages/shared/src/runtime-versions.json');
    expect(dockerfile).toContain("require('/tmp/kortix-runtime-versions.json').opencode");
    expect(dockerfile).toContain("require('/tmp/kortix-runtime-versions.json').agentBrowser");
    expect(dockerfile).toContain("require('/tmp/kortix-runtime-versions.json').playwright");
    expect(dockerfile).toContain("require('/tmp/kortix-runtime-versions.json').bun");
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
      slackCliPath: 'kortix-slack-cli',
      executorSdkPath: 'kortix-executor-sdk',
    });

    expect(merged).toContain(`opencode-ai@${OPENCODE_VERSION}`);
    expect(merged).toContain(`agent-browser@${AGENT_BROWSER_VERSION}`);
    expect(merged).toContain(`playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium`);
  });

  test('Codex/OpenAI OAuth traffic presents the same OpenCode user-agent pin', () => {
    expect(CODEX_USER_AGENT).toBe(OPENCODE_USER_AGENT);
  });
});
