import runtimeVersions from './runtime-versions.json' with { type: 'json' };

export type RuntimeVersions = {
  pnpm: string;
  node: string;
  npm: string;
  uv: string;
  python: string;
  opencode: string;
  opencodeSdk: string;
  agentBrowser: string;
  playwright: string;
};

export const RUNTIME_VERSIONS = runtimeVersions as RuntimeVersions;

export const PNPM_VERSION = RUNTIME_VERSIONS.pnpm;
export const NODE_VERSION = RUNTIME_VERSIONS.node;
export const NPM_VERSION = RUNTIME_VERSIONS.npm;
export const UV_VERSION = RUNTIME_VERSIONS.uv;
export const PYTHON_VERSION = RUNTIME_VERSIONS.python;
export const OPENCODE_VERSION = RUNTIME_VERSIONS.opencode;
export const OPENCODE_SDK_VERSION = RUNTIME_VERSIONS.opencodeSdk;
export const OPENCODE_USER_AGENT = `opencode/${OPENCODE_VERSION}`;
export const AGENT_BROWSER_VERSION = RUNTIME_VERSIONS.agentBrowser;
export const PLAYWRIGHT_VERSION = RUNTIME_VERSIONS.playwright;
