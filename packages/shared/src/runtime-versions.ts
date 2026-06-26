import runtimeVersions from './runtime-versions.json' with { type: 'json' };

export type RuntimeVersions = {
  opencode: string;
  opencodeSdk: string;
  agentBrowser: string;
  playwright: string;
};

export const RUNTIME_VERSIONS = runtimeVersions as RuntimeVersions;

export const OPENCODE_VERSION = RUNTIME_VERSIONS.opencode;
export const OPENCODE_SDK_VERSION = RUNTIME_VERSIONS.opencodeSdk;
export const OPENCODE_USER_AGENT = `opencode/${OPENCODE_VERSION}`;
export const AGENT_BROWSER_VERSION = RUNTIME_VERSIONS.agentBrowser;
export const PLAYWRIGHT_VERSION = RUNTIME_VERSIONS.playwright;
