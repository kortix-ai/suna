import runtimeVersions from './runtime-versions.json' with { type: 'json' };

export type RuntimeVersions = {
  opencode: string;
  opencodeSdk: string;
  claudeAgentAcp: string;
  codexAcp: string;
  piAcp: string;
  piCodingAgent: string;
  agentBrowser: string;
  playwright: string;
};

export const RUNTIME_VERSIONS = runtimeVersions as RuntimeVersions;

export const OPENCODE_VERSION = RUNTIME_VERSIONS.opencode;
export const OPENCODE_SDK_VERSION = RUNTIME_VERSIONS.opencodeSdk;
export const CLAUDE_AGENT_ACP_VERSION = RUNTIME_VERSIONS.claudeAgentAcp;
export const CODEX_ACP_VERSION = RUNTIME_VERSIONS.codexAcp;
export const PI_ACP_VERSION = RUNTIME_VERSIONS.piAcp;
export const PI_CODING_AGENT_VERSION = RUNTIME_VERSIONS.piCodingAgent;
export const OPENCODE_USER_AGENT = `opencode/${OPENCODE_VERSION}`;
export const AGENT_BROWSER_VERSION = RUNTIME_VERSIONS.agentBrowser;
export const PLAYWRIGHT_VERSION = RUNTIME_VERSIONS.playwright;
