import { describe, expect, test } from 'bun:test';
import {
  CLAUDE_AGENT_ACP_VERSION,
  CODEX_ACP_VERSION,
  PI_ACP_VERSION,
} from '@kortix/shared';

import { buildLayeredDockerfile } from '../snapshots/dockerfile-layer';

describe('ACP sandbox runtime layer', () => {
  test('bakes exact official adapter pins and verifies their executables', () => {
    const dockerfile = buildLayeredDockerfile({
      userDockerfile: 'FROM ubuntu:24.04',
      opencodeVersion: '1.17.11',
      agentBinaryPath: 'kortix-agent.gz',
      cliBinaryPath: 'kortix.gz',
      entrypointScriptPath: 'kortix-entrypoint',
      slackCliPath: 'kortix-slack-cli',
      executorSdkPath: 'kortix-executor-sdk',
    });

    expect(dockerfile).toContain(
      `@agentclientprotocol/claude-agent-acp@${CLAUDE_AGENT_ACP_VERSION}`,
    );
    expect(dockerfile).toContain(
      `@agentclientprotocol/codex-acp@${CODEX_ACP_VERSION}`,
    );
    expect(dockerfile).toContain(`pi-acp@${PI_ACP_VERSION}`);
    expect(dockerfile).toContain('n 22.23.1');
    expect(dockerfile).toContain('node --version | grep -Fx "v22.23.1"');
    expect(dockerfile).toContain('command -v claude-agent-acp');
    expect(dockerfile).toContain('command -v codex-acp');
    expect(dockerfile).toContain('command -v pi-acp');
  });
});
