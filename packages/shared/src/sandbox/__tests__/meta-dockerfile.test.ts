import { describe, expect, test } from 'bun:test';

import { PNPM_SHA256_AMD64, PNPM_SHA256_ARM64, PNPM_VERSION } from '../../runtime-versions';
import { SANDBOX_DESKTOP_INSTALL_COMMAND } from '../desktop';
import { kortixWorkstationTooling } from '../dockerfile-layer';
import { buildMetaSandboxDockerfile } from '../meta-dockerfile';

const dockerfile = buildMetaSandboxDockerfile({
  agentBinaryPath: 'artifacts/kortix-agent.gz',
  cliBinaryPath: 'artifacts/kortix.gz',
  entrypointScriptPath: 'artifacts/kortix-entrypoint.sh',
  machineDocPath: 'artifacts/MACHINE.md',
  slackCliPath: 'artifacts/kortix-slack-cli',
  managedSkillsPath: 'artifacts/managed-skills',
});

describe('buildMetaSandboxDockerfile', () => {
  test('is the Kortix defaults plus My Kortix\'s guide, on the platform default\'s base', () => {
    expect(dockerfile).toContain('FROM ubuntu:24.04');
    expect(dockerfile).toContain('pnpm runtime set node 22.23.1 -g');
    expect(dockerfile).not.toContain('pnpm list -g');
    expect(dockerfile).not.toContain('pnpm root -g');
    expect(dockerfile).toContain('PNPM_HOME=/home/kortix/.local/share/pnpm');
    expect(dockerfile).toContain('PATH=/home/kortix/.local/bin:/home/kortix/.local/share/pnpm/bin:/home/kortix/.bun/bin:$PATH');
    expect(dockerfile).toContain('/usr/local/bin/kortix-agent');
    expect(dockerfile).toContain('/usr/local/bin/kortix');
    expect(dockerfile).toContain('/workspace/AGENTS.md');
    expect(dockerfile).toContain('# My Kortix\n');
    expect(dockerfile).toContain('You are My Kortix: the one agent this person talks to in this project.');
    expect(dockerfile).toContain('NEVER do project work in this sandbox');
    expect(dockerfile).toContain('`kortix sessions new --agent <name> --prompt "<task>"`');
    expect(dockerfile).toContain('`kortix agents config <name> --file -`');
    expect(dockerfile).toContain('show the user the before and after, and ask once.');
    expect(dockerfile).toContain('Load the `kortix-goals` skill.');
    // The meta box has no /drives, where `kortix goals ls|status` refuse.
    expect(dockerfile).toContain('Never run `kortix goals ls` or `kortix goals status` here');
    expect(dockerfile).not.toContain('Then follow it with `kortix goals ls`');
    expect(dockerfile).toContain('Every App, Artifact or Goal you create names the agent or the space it belongs to.');
    expect(dockerfile).toContain('It cannot mint tokens. You never hold more than the user does in this project.');
    expect(dockerfile).toContain(
      'Move files between sessions with `kortix sessions cp <session-id>:<path> <session-id>:<path>`.',
    );
    expect(dockerfile).toContain(
      'To spawn a session with input files, use `kortix sessions new --with-file <local path> --prompt "<task>"`.',
    );
    expect(dockerfile).toContain('Each file lands in /workspace/incoming/ before the prompt is delivered');
    expect(dockerfile).toContain(
      'Specialized sessions do their task themselves and never spawn sessions.',
    );
    expect(dockerfile).toContain(
      'Specialized sessions run full sandboxes with Python (via `uv` — tell them to use `uv run`/`uvx`/`uv pip`,',
    );
    expect(dockerfile).toContain('Read the `kortix-system` skill before you coordinate');
    expect(dockerfile).toContain(
      'Wait for a session with `kortix sessions wait-for <session-id> --timeout 120`',
    );
    expect(dockerfile).toContain(
      'It grants every project action allowed to the user who started this session.',
    );
    expect(dockerfile).toContain(
      'It cannot access another project, account administration, project secrets, or connectors.',
    );
    expect(dockerfile).not.toContain('artifacts/AGENTS.md');
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
