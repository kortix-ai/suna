import { describe, expect, test } from 'bun:test';

import { buildMetaSandboxDockerfile } from '../meta-dockerfile';

describe('buildMetaSandboxDockerfile', () => {
  test('contains only the platform coordination runtime', () => {
    const dockerfile = buildMetaSandboxDockerfile({
      agentBinaryPath: 'artifacts/kortix-agent.gz',
      cliBinaryPath: 'artifacts/kortix.gz',
      entrypointScriptPath: 'artifacts/kortix-entrypoint.sh',
      catalogPath: 'artifacts/llm-catalog.json',
      managedSkillsPath: 'artifacts/managed-skills',
    });

    expect(dockerfile).toContain('FROM debian:bookworm-slim');
    expect(dockerfile).toContain('https://get.pnpm.io/install.sh');
    expect(dockerfile).toContain('PNPM_VERSION=11.15.1');
    expect(dockerfile).toContain('pnpm runtime set node 22.23.1 --global');
    expect(dockerfile).toContain('opencode-ai@1.18.23');
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
    expect(dockerfile).toContain('PNPM_HOME=/home/kortix/.local/share/pnpm');
    expect(dockerfile).toContain('PATH="/home/kortix/.local/share/pnpm/bin:${PATH}"');
    expect(dockerfile).toContain('/usr/local/bin/kortix-agent');
    expect(dockerfile).toContain('/usr/local/bin/kortix');
    expect(dockerfile).toContain('/workspace/AGENTS.md');
    expect(dockerfile).toContain('# Kortix Meta Agent');
    expect(dockerfile).toContain('You coordinate work. You do not perform project work in this sandbox.');
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
    expect(dockerfile).toContain('Read the `kortix-cli` skill before coordinating');
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
    expect(dockerfile).toContain('/ephemeral/kortix-master/opencode');
    expect(dockerfile).toContain('/opt/kortix/llm-catalog.json');
    expect(dockerfile).toContain(
      'COPY --chown=kortix:kortix artifacts/managed-skills /opt/kortix/managed-skills',
    );
    expect(dockerfile).toContain('KORTIX_PROJECT_AUTO_CLONE=0');
    expect(dockerfile).toContain('KORTIX_OPENCODE_PROCESS_TRANSPORT=rest');

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
});
