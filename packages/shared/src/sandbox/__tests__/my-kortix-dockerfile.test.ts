import { describe, expect, test } from 'bun:test';

import { PNPM_SHA256_AMD64, PNPM_SHA256_ARM64, PNPM_VERSION } from '../../runtime-versions';
import { buildMyKortixSandboxDockerfile } from '../my-kortix-dockerfile';

const dockerfile = buildMyKortixSandboxDockerfile({
  agentBinaryPath: 'artifacts/kortix-agent.gz',
  cliBinaryPath: 'artifacts/kortix.gz',
  entrypointScriptPath: 'artifacts/kortix-entrypoint.sh',
  managedSkillsPath: 'artifacts/managed-skills',
});

describe('buildMyKortixSandboxDockerfile', () => {
  test('contains only the platform coordination runtime', () => {
    expect(dockerfile).toContain('FROM debian:bookworm-slim');
    expect(dockerfile).toContain('pnpm runtime set node 22.23.1 --global');
    expect(dockerfile).not.toContain('pnpm list -g');
    expect(dockerfile).not.toContain('pnpm root -g');
    expect(dockerfile).toContain('PNPM_HOME=/home/kortix/.local/share/pnpm');
    expect(dockerfile).toContain('PATH="/home/kortix/.local/bin:/home/kortix/.local/share/pnpm/bin:${PATH}"');
    expect(dockerfile).toContain('/usr/local/bin/kortix-agent');
    expect(dockerfile).toContain('/usr/local/bin/kortix');
    // My Kortix's instructions ship in the API-served config (MY_KORTIX_PROMPT), not in the image.
    expect(dockerfile).not.toContain('AGENTS.md');
    expect(dockerfile).not.toContain('llm-catalog');
    expect(dockerfile).toContain(
      'COPY --chown=kortix:kortix artifacts/managed-skills /opt/kortix/managed-skills',
    );
    expect(dockerfile).toContain('KORTIX_PROJECT_AUTO_CLONE=0');

    expect(dockerfile).not.toContain('playwright');
    expect(dockerfile).not.toContain('chromium');
    expect(dockerfile).not.toContain('python');
    expect(dockerfile).not.toContain('libreoffice');
    expect(dockerfile).not.toContain('ffmpeg');
    expect(dockerfile).not.toContain('claude-agent-acp');
    expect(dockerfile).not.toContain('codex-acp');
    expect(dockerfile).not.toContain('pi-acp');
    expect(dockerfile).not.toContain('pi-coding-agent');
  });

  test('installs pnpm from the checksum-verified release artifact, never the public installer script', () => {
    // The toolchain layer's supply-chain rule (dockerfile-layer.ts) holds for
    // every image, including the meta box: install pnpm from its versioned
    // standalone release artifact after verifying the repository-controlled
    // checksum. The public installer script is not part of the trust path.
    // ponytail: install text duplicated from dockerfile-layer.ts per the issue;
    // share a stage builder when the toolchain-stage split lands.
    expect(dockerfile).not.toContain('get.pnpm.io');
    expect(dockerfile).not.toMatch(/curl[^|\n]*\|\s*(?:sh|bash)/);
    expect(dockerfile).toContain(
      `"https://github.com/pnpm/pnpm/releases/download/v${PNPM_VERSION}/pnpm-linux-\${pnpm_arch}.tar.gz"`,
    );
    expect(dockerfile).toContain(`pnpm_sha=${PNPM_SHA256_AMD64}`);
    expect(dockerfile).toContain(`pnpm_sha=${PNPM_SHA256_ARM64}`);
    expect(dockerfile).toContain('echo "${pnpm_sha}  /tmp/pnpm.tar.gz" | sha256sum -c -');
    expect(dockerfile).toContain(`test "$(HOME=/home/kortix pnpm --version)" = "${PNPM_VERSION}"`);
  });
});
