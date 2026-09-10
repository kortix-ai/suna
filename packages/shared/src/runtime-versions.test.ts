import { describe, expect, test } from "bun:test";
import {
  AGENT_BROWSER_VERSION,
  CLAUDE_CODE_VERSION,
  CODEX_CLI_VERSION,
  OPENCODE_SDK_VERSION,
  OPENCODE_USER_AGENT,
  OPENCODE_VERSION,
  PLAYWRIGHT_VERSION,
  RUNTIME_VERSIONS,
} from "./runtime-versions";

describe("runtime versions", () => {
  test("pins runtime CLI surfaces from one manifest", () => {
    expect(OPENCODE_VERSION).toBe(RUNTIME_VERSIONS.opencode);
    expect(OPENCODE_SDK_VERSION).toBe(RUNTIME_VERSIONS.opencodeSdk);
    expect(OPENCODE_USER_AGENT).toBe(`opencode/${RUNTIME_VERSIONS.opencode}`);
    expect(AGENT_BROWSER_VERSION).toBe(RUNTIME_VERSIONS.agentBrowser);
    expect(PLAYWRIGHT_VERSION).toBe(RUNTIME_VERSIONS.playwright);
    expect(CODEX_CLI_VERSION).toBe(RUNTIME_VERSIONS.codexCli);
    expect(CLAUDE_CODE_VERSION).toBe(RUNTIME_VERSIONS.claudeCode);
  });

  test("uses exact semver pins, not ranges or dist tags", () => {
    const versionKeys = [
      "pnpm",
      "node",
      "npm",
      "uv",
      "python",
      "bun",
      "opencode",
      "opencodeSdk",
      "agentBrowser",
      "playwright",
      "codexCli",
      "claudeCode",
    ] as const;

    for (const key of versionKeys) {
      expect(RUNTIME_VERSIONS[key]).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  test("uses exact lowercase SHA-256 digests for runtime artifacts", () => {
    const digestKeys = [
      "pnpmSha256Amd64",
      "pnpmSha256Arm64",
      "uvSha256Amd64",
      "uvSha256Arm64",
      "bunSha256Amd64",
      "bunSha256Arm64",
      "codexCliSha256Amd64",
      "codexCliSha256Arm64",
      "claudeCodeSha256Amd64",
      "claudeCodeSha256Arm64",
    ] as const;

    for (const key of digestKeys) {
      expect(RUNTIME_VERSIONS[key]).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
