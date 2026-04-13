/**
 * Sandbox URL detection and rewriting utilities.
 *
 * Detects localhost URLs in agent output (e.g. "Website is live at http://localhost:8080")
 * and rewrites them to subdomain-based preview URLs (like ngrok):
 *
 *   http://p{port}-{sandboxId}.localhost:{backendPort}/{path}
 *
 * The subdomain scheme means the proxied app thinks it's at root `/` — absolute
 * paths, Service Workers, WebSocket connections all work without any rewriting.
 * Auth is handled via a cookie set on the first `?token=` authenticated request.
 */

import { SANDBOX_PORTS } from '@/lib/platform-client';

// ── Types ────────────────────────────────────────────────────────────────────

export interface DetectedLocalhostUrl {
  /** The original full URL found in text (e.g. "http://localhost:8080/api/docs") */
  originalUrl: string;
  /** The port number */
  port: number;
  /** The path portion after the port (e.g. "/api/docs") */
  path: string;
  /** Start index in the source text */
  startIndex: number;
  /** End index in the source text */
  endIndex: number;
  /** Whether the URL was found inside a markdown code block or inline code span */
  inCodeBlock: boolean;
}

export interface ParsedLocalhostUrl {
  /** Canonicalized localhost URL (http(s)://localhost:PORT/path?query#hash) */
  originalUrl: string;
  /** Parsed port number */
  port: number;
  /** Parsed path + query + hash (always starts with /) */
  path: string;
}

/** Options for proxy URL generation */
export interface SubdomainUrlOptions {
  /** Sandbox ID (e.g. 'kortix-sandbox' for local, Daytona ID for cloud) */
  sandboxId: string;
  /** Backend port (e.g. 8008) — the port kortix-api listens on */
  backendPort: number;
  /**
   * The public-facing API base URL (e.g. 'https://e2e-test.kortix.cloud/v1').
   * When the user's browser is NOT on localhost, path-based proxy URLs are
   * generated from this:
   *   https://e2e-test.kortix.cloud/v1/p/{sandboxId}/{port}/{path}
   *
   * This makes proxy URLs work on VPS/self-hosted deployments where
   * *.localhost subdomain DNS resolution isn't available.
   */
  apiBaseUrl: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Regex to detect localhost URLs in text.
 * Matches: http://localhost:PORT, http://127.0.0.1:PORT, https://localhost:PORT
 * Captures optional path, query string, and fragment.
 * Does NOT match bare localhost without a port (too ambiguous).
 */
const LOCALHOST_URL_REGEX =
  /https?:\/\/(?:localhost|127\.0\.0\.1):\d{1,5}[^\s)"'<>]*/g;

/**
 * Regex to parse subdomain preview URLs.
 * Matches: http://p{port}-{sandboxId}.localhost:{backendPort}/{path}
 */
const SUBDOMAIN_URL_REGEX =
  /^https?:\/\/p(\d+)-([^.]+)\.localhost(?::(\d+))?(\/.*)?$/;

/**
 * Ports that should NOT be rewritten — they're already exposed/handled natively
 * by the sandbox infrastructure (VNC, OpenCode Web, presentation viewer, etc.)
 */
const EXCLUDED_PORTS = new Set([
  22, // SSH daemon — never preview/probe as HTTP
  4096, // OpenCode API (proxied by Kortix Master)
  parseInt(SANDBOX_PORTS.KORTIX_MASTER, 10), // Kortix Master itself
]);

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Check if a URL is a subdomain preview URL (p{port}-{sandboxId}.localhost).
 */
function isSubdomainUrl(url: string): boolean {
  return SUBDOMAIN_URL_REGEX.test(url);
}

function normalizePath(path: string): string {
  if (!path) return '/';

  let normalized = path;

  // Guard against markdown-link artifacts leaking into URL paths.
  const markdownBoundary = normalized.indexOf('](');
  if (markdownBoundary !== -1) {
    normalized = normalized.slice(0, markdownBoundary);
  }

  // Same guard after browser-encoding (`]` -> `%5D`).
  const encodedBoundary = normalized.toLowerCase().indexOf('%5d(');
  if (encodedBoundary !== -1) {
    normalized = normalized.slice(0, encodedBoundary);
  }

  if (!normalized) return '/';
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

/**
 * Markdown/plain-text extraction can include trailing markdown syntax when the
 * link label is itself a URL, e.g.:
 *   [http://localhost:3210/viewer.html](http://localhost:3210/viewer.html)
 * Trim that markdown boundary before URL parsing.
 */
function stripMarkdownArtifacts(url: string): string {
  const markerIndex = url.indexOf('](');
  if (markerIndex === -1) return url;
  return url.slice(0, markerIndex);
}

function stripUrlWrappers(url: string): string {
  let out = url.trim();
  out = out.replace(/^['"`<\(\[]+/, '');
  out = out.replace(/[>'"`\)\],;.!?]+$/, '');
  return out;
}

function extractLocalhostCandidate(text: string): string | null {
  const match = text.match(/https?:\/\/(?:localhost|127\.0\.0\.1):\d{1,5}[^\s"'<>)]*/i);
  return match?.[0] ?? null;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Regex to detect Kortix Master proxy URLs: localhost:8000/proxy/{port}/...
 * The agent inside the sandbox sees these URLs; the frontend needs to
 * extract the real service port and remaining path.
 */
const KORTIX_MASTER_PROXY_REGEX = /^\/proxy\/(\d{1,5})(\/.*)?$/;

/**
 * Known frontend app route prefixes. URLs with these pathnames on
 * localhost/127.0.0.1 are same-app navigations, NOT sandbox services
 * to proxy. They should render as plain clickable links.
 */
const APP_ROUTE_PREFIXES = /^\/(connectors|settings|dashboard|projects|agents|skills|tools|commands|deployments|support|changelog|files|p|browser|desktop|terminal|sessions|services|workspace|channels|scheduled-tasks|marketplace|templates|tunnel|admin|auth)(\/|$|\?)/;

export function isAppRouteUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') return false;
    return APP_ROUTE_PREFIXES.test(parsed.pathname);
  } catch {
    return false;
  }
}

/**
 * Parse a localhost URL in one place so all consumers share identical rules.
 *
 * Handles a special case: `http://localhost:8000/proxy/{port}/{path}` URLs
 * from inside the sandbox (Kortix Master). These are rewritten to appear as
 * `localhost:{port}/{path}` so they get proxied correctly.
 */
export function parseLocalhostUrl(
  rawUrl: string | undefined,
): ParsedLocalhostUrl | null {
  if (!rawUrl) return null;

  const candidate = stripUrlWrappers(stripMarkdownArtifacts(rawUrl.trim()));

  // Already-proxied subdomain preview URL:
  // http://p{port}-{sandboxId}.localhost:{backendPort}/{path}
  // Treat as an internal localhost URL so callers can render it like any
  // other live service URL.
  const subdomain = parseSubdomainUrl(candidate);
  if (subdomain) {
    const path = normalizePath(subdomain.path || '/');
    return {
      originalUrl: `http://localhost:${subdomain.port}${path}`,
      port: subdomain.port,
      path,
    };
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      return null;
    if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1')
      return null;
    if (!parsed.port) return null;

    let port = parseInt(parsed.port, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

    let pathStr = `${parsed.pathname || '/'}${parsed.search}${parsed.hash}`;

    // Special case: localhost:8000/proxy/{port}/... (Kortix Master proxy URL).
    // Extract the real port and remaining path so detection/rewriting works.
    const kortixMasterPort = parseInt(SANDBOX_PORTS.KORTIX_MASTER, 10);
    if (port === kortixMasterPort) {
      const proxyMatch = parsed.pathname.match(KORTIX_MASTER_PROXY_REGEX);
      if (proxyMatch) {
        const realPort = parseInt(proxyMatch[1], 10);
        if (realPort >= 1 && realPort <= 65535) {
          port = realPort;
          pathStr = normalizePath(
            `${proxyMatch[2] || '/'}${parsed.search}${parsed.hash}`,
          );
          return {
            originalUrl: `http://localhost:${port}${pathStr}`,
            port,
            path: pathStr,
          };
        }
      }
    }

    const path = normalizePath(pathStr);

    return {
      originalUrl: `${parsed.protocol}//${parsed.hostname}:${port}${path}`,
      port,
      path,
    };
  } catch {
    // Fallback: some tool outputs embed the localhost URL inside additional
    // prose. Extract the first localhost URL and parse it.
    const extracted = extractLocalhostCandidate(rawUrl);
    if (extracted && extracted !== rawUrl) {
      return parseLocalhostUrl(extracted);
    }
    return null;
  }
}

/**
 * Build a sorted array of [start, end] ranges covering all fenced code blocks
 * (```...```) and inline code spans (`...`) in the markdown text.
 * Used to exclude URLs that appear inside code from generating preview cards.
 */
function getCodeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];

  // Fenced code blocks: ```...``` (may have language specifier on opening line)
  const fencedRegex = /```[\s\S]*?```/g;
  let m: RegExpExecArray | null;
  while ((m = fencedRegex.exec(text)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }

  // Inline code spans: `...` (but not inside already-found fenced blocks)
  const inlineRegex = /`[^`\n]+`/g;
  while ((m = inlineRegex.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    // Only add if not already inside a fenced block range
    const insideFenced = ranges.some(([rs, re]) => start >= rs && end <= re);
    if (!insideFenced) {
      ranges.push([start, end]);
    }
  }

  return ranges;
}

/**
 * Check if an index falls inside any of the given ranges.
 */
function isInsideCodeBlock(
  index: number,
  ranges: Array<[number, number]>,
): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

/**
 * Detect all localhost URLs in a text string.
 * Tags each result with `inCodeBlock` so consumers can render URLs found
 * inside markdown code blocks / inline code differently (e.g. compact chips
 * instead of full preview cards with iframes).
 */
export function detectLocalhostUrls(text: string): DetectedLocalhostUrl[] {
  const results: DetectedLocalhostUrl[] = [];
  const seen = new Set<string>();
  const codeRanges = getCodeRanges(text);

  // Reset regex state
  LOCALHOST_URL_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = LOCALHOST_URL_REGEX.exec(text)) !== null) {
    const parsed = parseLocalhostUrl(match[0]);
    if (!parsed) continue;

    const { originalUrl, port, path } = parsed;

    // Skip invalid ports or excluded infrastructure ports
    if (port < 1 || port > 65535 || EXCLUDED_PORTS.has(port)) continue;
    // Deduplicate
    if (seen.has(originalUrl)) continue;
    seen.add(originalUrl);

    results.push({
      originalUrl,
      port,
      path,
      startIndex: match.index,
      endIndex: match.index + originalUrl.length,
      inCodeBlock: isInsideCodeBlock(match.index, codeRanges),
    });
  }

  return results;
}

/**
 * Check if a string contains any localhost URLs worth rewriting.
 */
export function hasLocalhostUrls(text: string): boolean {
  return detectLocalhostUrls(text).length > 0;
}

/**
 * Detect whether the kortix-api backend is on the user's own machine
 * (i.e. apiBaseUrl hostname is localhost/127.0.0.1).
 *
 * This — NOT where the browser is running — is the correct trigger for picking
 * between subdomain and path-based proxy. The subdomain proxy works by having
 * `*.localhost:{backendPort}` resolve to 127.0.0.1 on the user's machine. That
 * only reaches kortix-api if kortix-api is ALSO running on the user's machine.
 * If the backend lives remotely, *.localhost:8008 points at whatever the user
 * happens to have running locally — which is exactly the "internal browser
 * literally loads localhost" bug.
 */
function isBackendOnLocalhost(apiBaseUrl: string): boolean {
  try {
    const { hostname } = new URL(apiBaseUrl);
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

/**
 * Build a preview proxy URL for a sandbox service port.
 *
 * Both modes are proxy URLs — neither connects to the user's raw localhost.
 * Provider type (local_docker, daytona, justavps) is irrelevant; the only thing
 * that matters is whether kortix-api is running on the user's local machine,
 * because that determines whether *.localhost DNS can reach it.
 *
 *   - **Subdomain** (backend local): `http://p{port}-{sandboxId}.localhost:{backendPort}/{path}`
 *     Transparent mode — the proxied app thinks it's at root `/`. Only works
 *     when kortix-api is on 127.0.0.1.
 *
 *   - **Path-based** (backend remote): `{apiBaseUrl}/p/{sandboxId}/{port}/{path}`
 *     Goes through Caddy → API → sandbox. Used for all deployed setups.
 *
 * @example
 *   // Local dev:      → 'http://p3210-kortix-sandbox.localhost:8008/viewer.html'
 *   // Deployed back:  → 'https://e2e-test.kortix.cloud/v1/p/kortix-sandbox/3210/viewer.html'
 */
export function rewriteLocalhostUrl(
  port: number,
  path: string,
  subdomainOpts: SubdomainUrlOptions,
): string {
  const safePath = normalizePath(path);

  // Path-based proxy whenever the backend is NOT on the user's machine.
  // This is the only safe choice when apiBaseUrl is remote — the subdomain
  // scheme relies on *.localhost DNS which would point at the user's own box.
  if (!isBackendOnLocalhost(subdomainOpts.apiBaseUrl)) {
    // apiBaseUrl is like "https://e2e-test.kortix.cloud/v1" — strip trailing slash.
    const base = subdomainOpts.apiBaseUrl.replace(/\/+$/, '');
    return `${base}/p/${subdomainOpts.sandboxId}/${port}${safePath}`;
  }

  // Subdomain proxy — only used in true local-dev where kortix-api is on
  // 127.0.0.1 so *.localhost:{backendPort} is guaranteed to reach it.
  return `http://p${port}-${subdomainOpts.sandboxId}.localhost:${subdomainOpts.backendPort}${safePath}`;
}

/**
 * Build the proxy base URL for a given port (without path).
 * Used for opening preview tabs.
 */
export function getProxyBaseUrl(
  port: number,
  subdomainOpts: SubdomainUrlOptions,
): string {
  return rewriteLocalhostUrl(port, '/', subdomainOpts);
}

/**
 * Check if a URL is a localhost URL that we can proxy.
 * Excludes infrastructure ports AND the current app's own port so we never
 * rewrite the frontend's own navigation links.
 * Also excludes URLs that are already subdomain preview URLs.
 */
export function isProxiableLocalhostUrl(url: string): boolean {
  const parsed = parseLocalhostUrl(url);
  if (!parsed) return false;

  if (EXCLUDED_PORTS.has(parsed.port)) return false;

   // If the URL is a known frontend app route (e.g. /connectors?connect=...,
  // /settings, /dashboard) it must NOT be proxied — it is a navigation link to
  // the local frontend, not a sandbox service.  This is critical for the
   // connector-connect flow which generates http://localhost:3000/connectors?...
  // URLs that should open in the same browser tab, not go through the p3000-...
  // subdomain proxy.
  if (isAppRouteUrl(url)) return false;

  return true;
}

/**
 * If the given URL points to localhost:PORT, rewrite it through the sandbox
 * proxy layer. Returns the original URL unchanged when it doesn't match or
 * targets an excluded infrastructure port.
 *
 * This is the catch-all intended for use inside markdown renderers so that
 * every `<a href>`, `<img src>`, etc. that references a sandbox service
 * automatically gets proxied.
 */
export function proxyLocalhostUrl(
  url: string | undefined,
  subdomainOpts: SubdomainUrlOptions,
): string | undefined {
  if (!url) return url;

  const parsed = parseLocalhostUrl(url);
  if (!parsed) return url;

  // Don't rewrite URLs pointing at the app itself or already-proxied URLs
  if (!isProxiableLocalhostUrl(parsed.originalUrl)) return parsed.originalUrl;

  return rewriteLocalhostUrl(parsed.port, parsed.path, subdomainOpts);
}

/**
 * Build the internal (container-side) localhost URL for a given port + path.
 * This is what the user sees as the "real" address inside the sandbox.
 *
 * @example toInternalUrl(8080, '/api/docs') → 'http://localhost:8080/api/docs'
 */
export function toInternalUrl(port: number, path: string = '/'): string {
  return `http://localhost:${port}${path}`;
}

/**
 * Regex to detect path-based proxy URLs:
 *   https://domain/v1/p/{sandboxId}/{port}/{path}
 */
const PATH_PROXY_URL_REGEX =
  /^https?:\/\/[^/]+\/v1\/p\/([^/]+)\/(\d+)(\/.*)?$/;

/**
 * Parse a preview proxy URL back to its components.
 * Handles both subdomain and path-based formats:
 *
 * Subdomain: http://p3210-kortix-sandbox.localhost:8008/viewer.html
 * Path:      https://e2e-test.kortix.cloud/v1/p/kortix-sandbox/3210/viewer.html
 */
export function parseSubdomainUrl(url: string): {
  port: number;
  sandboxId: string;
  backendPort: number;
  path: string;
} | null {
  // Try subdomain format first
  const subMatch = url.match(SUBDOMAIN_URL_REGEX);
  if (subMatch) {
    return {
      port: parseInt(subMatch[1], 10),
      sandboxId: subMatch[2],
      backendPort: subMatch[3] ? parseInt(subMatch[3], 10) : 80,
      path: subMatch[4] || '/',
    };
  }

  // Try path-based format: /v1/p/{sandboxId}/{port}/{path}
  const pathMatch = url.match(PATH_PROXY_URL_REGEX);
  if (pathMatch) {
    try {
      const parsed = new URL(url);
      return {
        port: parseInt(pathMatch[2], 10),
        sandboxId: pathMatch[1],
        backendPort: parseInt(parsed.port, 10) || (parsed.protocol === 'https:' ? 443 : 80),
        path: pathMatch[3] || '/',
      };
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Try to reverse-map a proxy URL back to its internal localhost equivalent.
 *
 * Handles:
 *   - `http://p{port}-{sandboxId}.localhost:{backendPort}/{path}` → `http://localhost:{port}{path}`
 *   - Direct mapped port URLs (e.g. `http://localhost:14002/...`) → `http://localhost:6080/...`
 *
 * Returns null if the URL can't be reverse-mapped.
 */
export function proxyUrlToInternal(
  proxyUrl: string,
  mappedPorts?: Record<string, string>,
): string | null {
  try {
    // Subdomain URL — http://p{port}-{sandboxId}.localhost:{backendPort}/{path}
    const subdomain = parseSubdomainUrl(proxyUrl);
    if (subdomain) {
      return `http://localhost:${subdomain.port}${subdomain.path}`;
    }

    // Direct mapped port URL (e.g. http://localhost:14002/path)
    if (mappedPorts) {
      const url = new URL(proxyUrl);
      const hostPort = url.port;
      for (const [containerPort, mappedHostPort] of Object.entries(
        mappedPorts,
      )) {
        if (mappedHostPort === hostPort) {
          return `http://localhost:${containerPort}${url.pathname}${url.search}`;
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Check if a URL is already a preview proxy URL (subdomain or path-based).
 * Use this to prevent double-proxying.
 */
export function isPreviewUrl(url: string): boolean {
  return isSubdomainUrl(url) || PATH_PROXY_URL_REGEX.test(url);
}

// ── Web Forward Proxy Utilities ─────────────────────────────────────────────

const WEB_PROXY_PATH_PREFIX = '/web-proxy/';

/**
 * Build a web proxy URL that routes through the Kortix Master (port 8000)
 * which hosts the /web-proxy/ forward proxy.
 *
 * The web proxy lives on Kortix Master, NOT the OpenCode server, so we
 * construct a URL targeting port 8000 via the standard sandbox preview proxy.
 */
export function buildWebProxyUrl(
  targetUrl: string,
  subdomainOpts: SubdomainUrlOptions,
): string | null {
  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const scheme = parsed.protocol.replace(':', '');
    const proxyPath = `${WEB_PROXY_PATH_PREFIX}${scheme}/${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;

    const kmPort = parseInt(SANDBOX_PORTS.KORTIX_MASTER, 10); // 8000
    const baseUrl = rewriteLocalhostUrl(kmPort, '/', subdomainOpts);
    return `${baseUrl.replace(/\/$/, '')}${proxyPath}`;
  } catch {
    return null;
  }
}

export function parseWebProxyUrl(proxyUrl: string): string | null {
  try {
    const url = new URL(proxyUrl);
    const wpIdx = url.pathname.indexOf(WEB_PROXY_PATH_PREFIX);
    if (wpIdx === -1) return null;
    const remainder = url.pathname.slice(wpIdx + WEB_PROXY_PATH_PREFIX.length);
    const match = remainder.match(/^(https?)\/([\w.\-]+(?::\d+)?)(\/.*)?$/);
    if (!match) return null;
    const scheme = match[1];
    const host = match[2];
    const path = match[3] || '/';
    return `${scheme}://${host}${path}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

export function isWebProxyUrl(url: string): boolean {
  try {
    return new URL(url).pathname.includes(WEB_PROXY_PATH_PREFIX);
  } catch {
    return url.includes(WEB_PROXY_PATH_PREFIX);
  }
}

export function isExternalUrl(rawUrl: string): boolean {
  if (!rawUrl) return false;
  const trimmed = rawUrl.trim();
  if (/^https?:\/\/(?!localhost|127\.0\.0\.1)/i.test(trimmed)) return true;
  if (/^[a-z0-9][\w.-]*\.[a-z]{2,}/i.test(trimmed)) return true;
  return false;
}

export function normalizeExternalInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-z0-9][\w.-]*\.[a-z]{2,}/i.test(trimmed)) return `https://${trimmed}`;
  return null;
}
