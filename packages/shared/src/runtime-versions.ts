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
  pythonPackages: Record<string, string>;
  bun: string;
  bunSha256Amd64: string;
  bunSha256Arm64: string;
  /** @deprecated OpenCode only. OpenCode is sunset (2026-10-23): no new code. See apps/kortix-sandbox-agent-server/src/harness/README.md "OpenCode sunset". */
  opencode: string;
  /** @deprecated OpenCode only. OpenCode is sunset (2026-10-23): no new code. See apps/kortix-sandbox-agent-server/src/harness/README.md "OpenCode sunset". */
  opencodeSdk: string;
  agentBrowser: string;
  agentDesktop: string;
  playwright: string;
  anydoc: string;
  /** The Claude Code program Claude subscription models run (`claude --version`). */
  claudeCode: string;
  /** The Claude Agent SDK release that ships that program (its `claudeCodeVersion`); kortixd pins the same SDK. */
  claudeAgentSdk: string;
  /** tembo/voxl commit the sandbox desktop streamer is built from (apps/sandbox/voxl/release.sh). */
  voxl: string;
  voxlSha256Amd64: string;
  voxlSha256Arm64: string;
  /** pi packages every pi session loads, as pi sources: `npm:<name>@<exact version>`. */
  piSystemPackages: string[];
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
export const PYTHON_PACKAGE_FLOOR = RUNTIME_VERSIONS.pythonPackages;
export const PYTHON_PACKAGE_FLOOR_IMPORTS: Record<string, string> = {
  lxml: 'lxml',
  'markitdown[pptx]': 'markitdown',
  openpyxl: 'openpyxl',
  pandas: 'pandas',
  pdf2docx: 'pdf2docx',
  pdf2image: 'pdf2image',
  pdfplumber: 'pdfplumber',
  pillow: 'PIL',
  playwright: 'playwright',
  pymupdf: 'fitz',
  pypdf: 'pypdf',
  pypdfium2: 'pypdfium2',
  pytesseract: 'pytesseract',
  'python-docx': 'docx',
  'python-pptx': 'pptx',
  reportlab: 'reportlab',
};
export const BUN_VERSION = RUNTIME_VERSIONS.bun;
export const BUN_SHA256_AMD64 = RUNTIME_VERSIONS.bunSha256Amd64;
export const BUN_SHA256_ARM64 = RUNTIME_VERSIONS.bunSha256Arm64;
/** @deprecated OpenCode only. OpenCode is sunset (2026-10-23): no new code. See apps/kortix-sandbox-agent-server/src/harness/README.md "OpenCode sunset". */
export const OPENCODE_VERSION = RUNTIME_VERSIONS.opencode;
/** @deprecated OpenCode only. OpenCode is sunset (2026-10-23): no new code. See apps/kortix-sandbox-agent-server/src/harness/README.md "OpenCode sunset". */
export const OPENCODE_SDK_VERSION = RUNTIME_VERSIONS.opencodeSdk;
export const OPENCODE_USER_AGENT = `opencode/${OPENCODE_VERSION}`;
export const AGENT_BROWSER_VERSION = RUNTIME_VERSIONS.agentBrowser;
export const AGENT_DESKTOP_VERSION = RUNTIME_VERSIONS.agentDesktop;
export const PLAYWRIGHT_VERSION = RUNTIME_VERSIONS.playwright;
export const ANYDOC_VERSION = RUNTIME_VERSIONS.anydoc;
export const CLAUDE_CODE_VERSION = RUNTIME_VERSIONS.claudeCode;
export const CLAUDE_AGENT_SDK_VERSION = RUNTIME_VERSIONS.claudeAgentSdk;
/** Where every image installs the Claude Code program (kortixd's default `KORTIX_CLAUDE_PATH`). */
export const CLAUDE_CODE_PATH = '/opt/kortix/claude/bin/claude';
export const VOXL_VERSION = RUNTIME_VERSIONS.voxl;
export const VOXL_SHA256_AMD64 = RUNTIME_VERSIONS.voxlSha256Amd64;
export const VOXL_SHA256_ARM64 = RUNTIME_VERSIONS.voxlSha256Arm64;
/** The GitHub release apps/sandbox/voxl/release.sh publishes for VOXL_VERSION. */
export const VOXL_RELEASE_URL = `https://github.com/kortix-ai/suna/releases/download/voxl-${VOXL_VERSION.slice(0, 12)}-kortix.2`;

// An exact npm pin. Each spec is inlined into the image's install RUN line, so
// the pattern also keeps every shell metacharacter out.
const PI_SYSTEM_PACKAGE = /^npm:(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** Throws unless `source` is an exact `npm:<name>@<x.y.z>` pin. */
export function assertPiSystemPackage(source: string): void {
  if (!PI_SYSTEM_PACKAGE.test(source)) {
    throw new Error(`pi system package "${source}" must be an exact npm pin: npm:<name>@<x.y.z>`);
  }
}

/**
 * The packages pi hands to every extension itself (virtual modules in the
 * compiled daemon). An install of pi packages satisfies their peer range with an
 * empty stub instead of a second copy.
 */
export const PI_SUPPLIED_PACKAGES: readonly string[] = [
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-tui',
];

/**
 * The pi system packages: installed into every sandbox image, loaded by every
 * pi session (apps/kortix-sandbox-agent-server/src/harness/README.md). To add
 * one from https://pi.dev/packages, append `npm:<name>@<version>`.
 */
export const PI_SYSTEM_PACKAGES: readonly string[] = RUNTIME_VERSIONS.piSystemPackages ?? [];
