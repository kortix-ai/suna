import runtimeVersions from './runtime-versions.json' with { type: 'json' };

export type RuntimeVersions = {
  opencode: string;
  opencodeSdk: string;
  claudeAgentAcp: string;
  codexAcp: string;
  piAcp: string;
  piCodingAgent: string;
  claudeCode: string;
  codexCli: string;
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
/** Official Anthropic Claude Code CLI (`claude`) — `@anthropic-ai/claude-code`,
 *  published by anthropic.com accounts. Distinct from the ACP adapter
 *  (`@agentclientprotocol/claude-agent-acp`, binary `claude-agent-acp`): this
 *  is the actual interactive/terminal CLI a user expects on PATH. */
export const CLAUDE_CODE_VERSION = RUNTIME_VERSIONS.claudeCode;
/** Official OpenAI Codex CLI (`codex`) — `@openai/codex`, published via
 *  OpenAI's GitHub Actions OIDC trusted publisher for openai/codex. Distinct
 *  from the ACP adapter (`@agentclientprotocol/codex-acp`, binary `codex-acp`). */
export const CODEX_CLI_VERSION = RUNTIME_VERSIONS.codexCli;
export const OPENCODE_USER_AGENT = `opencode/${OPENCODE_VERSION}`;
export const AGENT_BROWSER_VERSION = RUNTIME_VERSIONS.agentBrowser;
export const PLAYWRIGHT_VERSION = RUNTIME_VERSIONS.playwright;
