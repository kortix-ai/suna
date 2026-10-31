import { describe, expect, test } from 'bun:test';

import { PNPM_SHA256_AMD64, PNPM_SHA256_ARM64, PNPM_VERSION } from '../../runtime-versions';
import { SANDBOX_DESKTOP_INSTALL_COMMAND } from '../desktop';
import { kortixWorkstationTooling } from '../dockerfile-layer';
import { buildMyKortixSandboxDockerfile } from '../my-kortix-dockerfile';

const dockerfile = buildMyKortixSandboxDockerfile({
  agentBinaryPath: 'artifacts/kortix-agent.gz',
  cliBinaryPath: 'artifacts/kortix.gz',
  entrypointScriptPath: 'artifacts/kortix-entrypoint.sh',
  machineDocPath: 'artifacts/MACHINE.md',
  slackCliPath: 'artifacts/kortix-slack-cli',
  managedSkillsPath: 'artifacts/managed-skills',
});

describe('buildMyKortixSandboxDockerfile', () => {
  test('is the Kortix defaults on the platform default\'s base, with no guide baked in', () => {
    expect(dockerfile).toContain('FROM ubuntu:24.04');
    expect(dockerfile).toContain('pnpm runtime set node 22.23.1 -g');
    expect(dockerfile).not.toContain('pnpm list -g');
    expect(dockerfile).not.toContain('pnpm root -g');
    expect(dockerfile).toContain('PNPM_HOME=/home/kortix/.local/share/pnpm');
    expect(dockerfile).toContain('PATH=/home/kortix/.local/bin:/home/kortix/.local/share/pnpm/bin:/home/kortix/.bun/bin:$PATH');
    expect(dockerfile).toContain('/usr/local/bin/kortix-agent');
    expect(dockerfile).toContain('/usr/local/bin/kortix');
    // My Kortix's instructions ship in the API-served config (MY_KORTIX_PROMPT), not in the image.
    expect(dockerfile).not.toContain('AGENTS.md');
    expect(dockerfile).not.toContain('llm-catalog');
    expect(dockerfile).toContain(
      'COPY --chown=kortix:kortix artifacts/managed-skills /opt/kortix/managed-skills',
    );
    expect(dockerfile).toContain('KORTIX_PROJECT_AUTO_CLONE=0');

    // No project-agent workstation: My Kortix delegates that work.
    expect(dockerfile).not.toContain(kortixWorkstationTooling({}));
    expect(dockerfile).not.toContain(SANDBOX_DESKTOP_INSTALL_COMMAND);
    expect(dockerfile).not.toContain('playwright');
    expect(dockerfile).not.toContain('chromium');
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
    expect(dockerfile).not.toContain('get.pnpm.io');
    expect(dockerfile).not.toMatch(/curl[^|\n]*\|\s*(?:sh|bash)/);
    expect(dockerfile).toContain(
      `"https://github.com/pnpm/pnpm/releases/download/v${PNPM_VERSION}/pnpm-linux-\${pnpm_arch}.tar.gz"`,
    );
    expect(dockerfile).toContain(`pnpm_sha=${PNPM_SHA256_AMD64}`);
    expect(dockerfile).toContain(`pnpm_sha=${PNPM_SHA256_ARM64}`);
    expect(dockerfile).toContain('echo "${pnpm_sha}  /tmp/pnpm.tar.gz" | sha256sum -c -');
    expect(dockerfile).toContain(`test "$(pnpm --version)" = "${PNPM_VERSION}"`);
  });
});
