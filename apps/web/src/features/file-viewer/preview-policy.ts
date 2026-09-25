/**
 * The preview policy for "show this file": which renderer a file gets, and
 * how a frame that shows agent-written content is sandboxed.
 *
 * The file viewer, the `show` card, the deck viewer and the public share page
 * all ask this module. None of them picks an extension list or a sandbox token
 * set of its own, so two surfaces cannot show the same file two ways.
 */

import {
  INTERACTIVE_PREVIEW_IFRAME_SANDBOX,
  ISOLATED_HTML_PREVIEW_IFRAME_SANDBOX,
  ISOLATED_SLIDE_IFRAME_SANDBOX,
  SLIDE_IFRAME_SANDBOX,
} from '@/lib/security/iframe-sandbox';
import { privilegedFrameOrigins } from '@/lib/security/privileged-frame-origins';
import { SANDBOX_PORTS } from '@kortix/sdk';

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export type FileCategory =
  | 'image'
  | 'pdf'
  | 'docx'
  | 'pptx'
  | 'xlsx'
  | 'csv'
  | 'sqlite'
  | 'video'
  | 'audio'
  | 'html'
  | 'zip'
  | 'code'
  | 'text'
  | 'binary';

export function getFileCategory(filename: string, mimeType?: string): FileCategory {
  const ext = filename.split('.').pop()?.toLowerCase() || '';

  if (
    [
      'png',
      'jpg',
      'jpeg',
      'gif',
      'svg',
      'webp',
      'ico',
      'bmp',
      'avif',
      'tiff',
      'tif',
      'heic',
      'heif',
    ].includes(ext)
  )
    return 'image';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (['pptx', 'ppt'].includes(ext)) return 'pptx';
  if (['xlsx', 'xls'].includes(ext)) return 'xlsx';
  if (['csv', 'tsv'].includes(ext)) return 'csv';
  if (['db', 'sqlite', 'sqlite3', 'db3', 'sdb', 's3db'].includes(ext)) return 'sqlite';
  if (['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v', 'ogv'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'opus', 'wma'].includes(ext)) return 'audio';
  if (['html', 'htm'].includes(ext)) return 'html';
  // Zip CONTAINERS only. `.docx`/`.xlsx`/`.pptx` are zips too and are matched
  // above, because their contents are an implementation detail rather than
  // something anyone wants to browse. `.tar.gz`/`.tgz` are deliberately absent
  // — they are not zip, and jszip cannot read them.
  if (['zip', 'jar', 'war', 'whl', 'vsix', 'nupkg', 'xpi', 'apk'].includes(ext)) return 'zip';

  // Code/text files
  if (getLanguageFromExt(filename) !== 'plaintext') return 'code';
  if (mimeType?.startsWith('text/')) return 'text';

  return 'binary';
}

export function getLanguageFromExt(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const fileNameLower = filename.toLowerCase();
  const baseName = (fileNameLower.split('/').pop() ?? fileNameLower).split('.')[0];

  // .env files (e.g., .env, .env.local, .env.production)
  if (fileNameLower.includes('.env') || fileNameLower.startsWith('.env')) {
    return 'properties';
  }

  // Files without a useful extension — detect by base name
  if (baseName === 'dockerfile' || fileNameLower.startsWith('dockerfile.')) return 'dockerfile';
  if (baseName === 'makefile' || baseName === 'gnumakefile') return 'makefile';

  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    mjs: 'javascript',
    cjs: 'javascript',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    swift: 'swift',
    kt: 'kotlin',
    php: 'php',
    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    json: 'json',
    jsonc: 'json',
    json5: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    xml: 'xml',
    sql: 'sql',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    fish: 'bash',
    md: 'markdown',
    mdx: 'markdown',
    mmd: 'mermaid',
    mermaid: 'mermaid',
    txt: 'plaintext',
    dockerfile: 'dockerfile',
    makefile: 'makefile',
    vue: 'vue',
    svelte: 'svelte',
    env: 'properties',
    ini: 'properties',
    conf: 'properties',
    cfg: 'properties',
    properties: 'properties',
    graphql: 'graphql',
    gql: 'graphql',
    prisma: 'prisma',
    proto: 'proto',
    nix: 'nix',
    lua: 'lua',
    r: 'r',
    dart: 'dart',
    tf: 'hcl',
    hcl: 'hcl',
    tfvars: 'hcl',
    diff: 'diff',
    patch: 'diff',
    vim: 'vim',
  };
  return map[ext] || 'plaintext';
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/**
 * What an agent put in a frame.
 *
 * - `document` — a file it wrote, served as written (an HTML file, inline HTML
 *   from a `show` card, a shared HTML file). Always an opaque origin: the page
 *   runs scripts, forms, popups and downloads, and cannot read the storage or
 *   send the cookies of any origin it is served from.
 * - `app` — a server it runs (a dev server shown in a `show` card). Keeps its
 *   origin on a per-sandbox preview host, where the app needs its own cookies
 *   and storage; opaque on a privileged origin.
 * - `slide` — a deck slide: scripts and modals only. Same origin rule as `app`.
 */
export type FrameContent = 'document' | 'app' | 'slide';

export interface FramePolicy {
  /** The iframe `sandbox` attribute. */
  sandbox: string;
  /** `own`: the frame keeps the origin it is served from. `opaque`: it gets a unique, opaque one. */
  origin: 'own' | 'opaque';
}

/**
 * The sandbox for a frame whose document an agent wrote.
 *
 * A frame keeps its origin only when that origin is its own (a per-sandbox
 * preview host). When `src` resolves to one of `privilegedOrigins` — this app,
 * the configured app URL, or the API that serves the path proxy
 * `/v1/p/<sandbox>/<port>/…` — it runs with an opaque origin instead. A `src`
 * that does not parse is treated as privileged.
 */
export function framePolicy(
  content: FrameContent,
  src: string,
  privilegedOrigins: readonly string[] = privilegedFrameOrigins(),
): FramePolicy {
  const own = content !== 'document' && !isOnPrivilegedOrigin(src, privilegedOrigins);
  if (content === 'slide') {
    return own
      ? { sandbox: SLIDE_IFRAME_SANDBOX, origin: 'own' }
      : { sandbox: ISOLATED_SLIDE_IFRAME_SANDBOX, origin: 'opaque' };
  }
  return own
    ? { sandbox: INTERACTIVE_PREVIEW_IFRAME_SANDBOX, origin: 'own' }
    : { sandbox: ISOLATED_HTML_PREVIEW_IFRAME_SANDBOX, origin: 'opaque' };
}

const STATIC_FILE_SERVER_PORT = Number(SANDBOX_PORTS.STATIC_FILE_SERVER);

/**
 * What a sandbox service on `port` serves. The static file server serves the
 * files an agent wrote, as written: a `document`. Every other port is a server
 * the agent runs: an `app`.
 */
export function serviceFrameContent(port: number | undefined): 'document' | 'app' {
  return port === STATIC_FILE_SERVER_PORT ? 'document' : 'app';
}

function originOf(value: string, base?: string): string | null {
  try {
    const url = base ? new URL(value, base) : new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Relative `src` resolves against the first privileged origin (the page). */
function isOnPrivilegedOrigin(src: string, privilegedOrigins: readonly string[]): boolean {
  const privileged = privilegedOrigins
    .map((origin) => originOf(origin))
    .filter((origin): origin is string => origin !== null);
  const frameOrigin = originOf(src, privileged[0]);
  if (!frameOrigin) return true;
  return privileged.includes(frameOrigin);
}
