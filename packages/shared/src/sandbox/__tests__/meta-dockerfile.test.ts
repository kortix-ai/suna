import { describe, expect, test } from 'bun:test';

import { buildMetaSandboxDockerfile, META_AGENT_GUIDE } from '../meta-dockerfile';

describe('buildMetaSandboxDockerfile', () => {
  test('contains only the platform coordination runtime', () => {
    const dockerfile = buildMetaSandboxDockerfile({
      agentBinaryPath: 'artifacts/kortix-agent.gz',
      cliBinaryPath: 'artifacts/kortix.gz',
      entrypointScriptPath: 'artifacts/kortix-entrypoint.sh',
      catalogPath: 'artifacts/llm-catalog.json',
      managedSkillsPath: 'artifacts/managed-skills',
      agentGuidePath: 'artifacts/meta-agents.md',
    });

    expect(dockerfile).toContain('FROM ubuntu:24.04');
    expect(dockerfile).toContain('v11.15.1/pnpm-linux-');
    expect(dockerfile).toContain('pnpm runtime set node 22.23.1 -g');
    expect(dockerfile).toContain('opencode-ai@1.17.11');
    expect(dockerfile).not.toContain('get.pnpm.io/install.sh');
    expect(dockerfile).toContain('PNPM_HOME=/home/kortix/.local/share/pnpm');
    expect(dockerfile).toContain('PATH=/home/kortix/.local/bin:/home/kortix/.local/share/pnpm/bin:$PATH');
    expect(dockerfile).toContain('/usr/local/bin/kortix-agent');
    expect(dockerfile).toContain('/usr/local/bin/kortix');
    expect(dockerfile).toContain('/workspace/AGENTS.md');
    // The agent guide is a staged-file COPY, not an inline heredoc: E2B's
    // Dockerfile parser rejects heredoc COPY instructions.
    expect(dockerfile).toContain(
      'COPY --chown=kortix:kortix artifacts/meta-agents.md /workspace/AGENTS.md',
    );
    expect(dockerfile).not.toContain('<<');
    expect(dockerfile).not.toContain('KORTIX_META_AGENT_GUIDE');
    expect(META_AGENT_GUIDE).toContain('# Kortix Meta Agent');
    expect(META_AGENT_GUIDE).toContain(
      'You coordinate work. You do not perform project work in this sandbox.',
    );
    expect(META_AGENT_GUIDE).toContain(
      'Move files between sessions with `kortix sessions cp <session-id>:<path> <session-id>:<path>`.',
    );
    expect(META_AGENT_GUIDE).toContain(
      'To spawn a session with input files, use `kortix sessions new --with-file <local path> --prompt "<task>"`.',
    );
    expect(META_AGENT_GUIDE).toContain(
      'Each file lands in /workspace/incoming/ before the prompt is delivered',
    );
    expect(META_AGENT_GUIDE).toContain(
      'Specialized sessions do their task themselves and never spawn sessions.',
    );
    expect(META_AGENT_GUIDE).toContain(
      'Specialized sessions run full sandboxes with Python (via `uv` — tell them to use `uv run`/`uvx`/`uv pip`,',
    );
    expect(META_AGENT_GUIDE).toContain('Read the `kortix-cli` skill before coordinating');
    expect(META_AGENT_GUIDE).toContain(
      'Wait for a session with `kortix sessions wait-for <session-id> --timeout 120`',
    );
    expect(META_AGENT_GUIDE).toContain(
      'It grants every project action allowed to the user who started this session.',
    );
    expect(META_AGENT_GUIDE).toContain(
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
