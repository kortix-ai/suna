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
  opencode: string;
  opencodeSdk: string;
  agentBrowser: string;
  playwright: string;
  anydoc: string;
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
export const OPENCODE_VERSION = RUNTIME_VERSIONS.opencode;
export const OPENCODE_SDK_VERSION = RUNTIME_VERSIONS.opencodeSdk;
export const OPENCODE_USER_AGENT = `opencode/${OPENCODE_VERSION}`;
export const AGENT_BROWSER_VERSION = RUNTIME_VERSIONS.agentBrowser;
export const PLAYWRIGHT_VERSION = RUNTIME_VERSIONS.playwright;
export const ANYDOC_VERSION = RUNTIME_VERSIONS.anydoc;

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
