import runtimeVersions from './runtime-versions.json' with { type: 'json' };

export type RuntimeVersions = {
  pnpm: string;
  pnpmSha256Amd64: string;
  pnpmSha256Arm64: string;
  node: string;
  npm: string;
  uv: string;
  uvSha256Amd64: string;
  uvSha256Arm64: string;
  python: string;
  bun: string;
  bunSha256Amd64: string;
  bunSha256Arm64: string;
  opencode: string;
  opencodeSdk: string;
  agentBrowser: string;
  playwright: string;
};

export const RUNTIME_VERSIONS = runtimeVersions as RuntimeVersions;

export const PNPM_VERSION = RUNTIME_VERSIONS.pnpm;
export const PNPM_SHA256_AMD64 = RUNTIME_VERSIONS.pnpmSha256Amd64;
export const PNPM_SHA256_ARM64 = RUNTIME_VERSIONS.pnpmSha256Arm64;
export const NODE_VERSION = RUNTIME_VERSIONS.node;
export const NPM_VERSION = RUNTIME_VERSIONS.npm;
export const UV_VERSION = RUNTIME_VERSIONS.uv;
export const UV_SHA256_AMD64 = RUNTIME_VERSIONS.uvSha256Amd64;
export const UV_SHA256_ARM64 = RUNTIME_VERSIONS.uvSha256Arm64;
export const PYTHON_VERSION = RUNTIME_VERSIONS.python;
export const BUN_VERSION = RUNTIME_VERSIONS.bun;
export const BUN_SHA256_AMD64 = RUNTIME_VERSIONS.bunSha256Amd64;
export const BUN_SHA256_ARM64 = RUNTIME_VERSIONS.bunSha256Arm64;
export const OPENCODE_VERSION = RUNTIME_VERSIONS.opencode;
export const OPENCODE_SDK_VERSION = RUNTIME_VERSIONS.opencodeSdk;
export const OPENCODE_USER_AGENT = `opencode/${OPENCODE_VERSION}`;
export const AGENT_BROWSER_VERSION = RUNTIME_VERSIONS.agentBrowser;
export const PLAYWRIGHT_VERSION = RUNTIME_VERSIONS.playwright;
