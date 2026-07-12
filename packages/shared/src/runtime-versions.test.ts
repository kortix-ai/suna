import { describe, expect, test } from 'bun:test';
import {
  AGENT_BROWSER_VERSION,
  CLAUDE_AGENT_ACP_VERSION,
  CODEX_ACP_VERSION,
  OPENCODE_SDK_VERSION,
  OPENCODE_USER_AGENT,
  OPENCODE_VERSION,
  PLAYWRIGHT_VERSION,
  PI_ACP_VERSION,
  PI_CODING_AGENT_VERSION,
  RUNTIME_VERSIONS,
} from './runtime-versions';

describe('runtime versions', () => {
  test('pins OpenCode runtime surfaces from one manifest', () => {
    expect(OPENCODE_VERSION).toBe(RUNTIME_VERSIONS.opencode);
    expect(OPENCODE_SDK_VERSION).toBe(RUNTIME_VERSIONS.opencodeSdk);
    expect(OPENCODE_USER_AGENT).toBe(`opencode/${RUNTIME_VERSIONS.opencode}`);
    expect(AGENT_BROWSER_VERSION).toBe(RUNTIME_VERSIONS.agentBrowser);
    expect(PLAYWRIGHT_VERSION).toBe(RUNTIME_VERSIONS.playwright);
    expect(CLAUDE_AGENT_ACP_VERSION).toBe(RUNTIME_VERSIONS.claudeAgentAcp);
    expect(CODEX_ACP_VERSION).toBe(RUNTIME_VERSIONS.codexAcp);
    expect(PI_ACP_VERSION).toBe(RUNTIME_VERSIONS.piAcp);
    expect(PI_CODING_AGENT_VERSION).toBe(RUNTIME_VERSIONS.piCodingAgent);
  });

  test('uses exact semver pins, not ranges or dist tags', () => {
    for (const version of Object.values(RUNTIME_VERSIONS)) {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
