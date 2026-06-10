import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { configFilePath } from './api/config.ts';
import { C, stripAnsi } from './style.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Update notifier.
//
// On `kortix` (bare) we resolve the latest published release from GitHub and,
// if it's newer than the running binary, surface a prominent box telling the
// user to run `kortix update`. Subcommands get a passive one-line nudge.
//
// To keep this off the hot path we cache the last-known latest version in
// ~/.config/kortix/update-check.json and only hit the network at most once per
// CHECK_TTL_MS. Subcommands never fetch — they render purely from cache, so the
// notice costs nothing once the cache is warm.
//
// Same release source as scripts/install.sh: the latest non-prerelease GitHub
// Release is the unified vX.Y.Z build.
// ─────────────────────────────────────────────────────────────────────────────

const REPO = process.env.KORTIX_REPO ?? 'kortix-ai/suna';
const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const CHECK_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const FETCH_TIMEOUT_MS = 1500;

interface CacheEntry {
  latest: string;
  checkedAt: number;
}

function cachePath(): string {
  return resolve(dirname(configFilePath()), 'update-check.json');
}

/** Update checks are pointless or unwanted in these cases. */
function isDisabled(current: string): boolean {
  if (process.env.KORTIX_NO_UPDATE_CHECK || process.env.KORTIX_SKIP_UPDATE_CHECK) return true;
  // CI/scripts: don't nag, and don't add latency to piped output.
  if (process.stdout.isTTY !== true) return true;
  if (process.env.CI) return true;
  // Local source runs (`bun run src/index.ts`) and dev builds have no stable
  // released version to compare against.
  if (current === 'dev' || current.includes('-dev.')) return true;
  return false;
}

/** Parse "v0.9.16" / "0.9.16-dev.abc" → [0, 9, 16]; null if unparseable. */
function parseVersion(raw: string): [number, number, number] | null {
  const core = raw.trim().replace(/^v/, '').split('-')[0];
  const parts = core.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
  return [parts[0]!, parts[1]!, parts[2]!];
}

/** Positive when a > b. */
function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! - b[i]!;
  }
  return 0;
}

function readCache(): CacheEntry | null {
  try {
    const raw = readFileSync(cachePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<CacheEntry>;
    if (typeof parsed.latest === 'string' && typeof parsed.checkedAt === 'number') {
      return { latest: parsed.latest, checkedAt: parsed.checkedAt };
    }
  } catch {
    /* missing or corrupt — treat as no cache */
  }
  return null;
}

function writeCache(entry: CacheEntry): void {
  try {
    const path = cachePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    /* best-effort; a failed cache write just means we re-check next time */
  }
}

async function fetchLatestTag(): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(LATEST_RELEASE_URL, {
      signal: ctrl.signal,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'kortix-cli' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { tag_name?: unknown };
    return typeof data.tag_name === 'string' ? data.tag_name : null;
  } catch {
    return null; // offline, timeout, rate-limited — silently skip
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the latest release tag. Uses the cache when it's fresh; otherwise
 * fetches (only when `allowFetch`) and refreshes the cache. Returns whatever
 * the cache holds as a fallback so subcommands still show a stale-but-useful
 * notice without ever touching the network.
 */
async function resolveLatestTag(allowFetch: boolean): Promise<string | null> {
  const cached = readCache();
  const fresh = cached && Date.now() - cached.checkedAt < CHECK_TTL_MS;
  if (fresh) return cached.latest;
  if (!allowFetch) return cached?.latest ?? null;

  const tag = await fetchLatestTag();
  if (tag) {
    writeCache({ latest: tag, checkedAt: Date.now() });
    return tag;
  }
  return cached?.latest ?? null;
}

const BOX_INNER = 52;

function boxLine(content: string): string {
  const padding = Math.max(0, BOX_INNER - stripAnsi(content).length);
  return `  ${C.yellow}║${C.reset} ${content}${' '.repeat(padding)} ${C.yellow}║${C.reset}`;
}

function renderBox(current: string, latestDisplay: string): string {
  const title = ' update available ';
  const fill = Math.max(0, BOX_INNER + 2 - 2 - title.length);
  const top = `  ${C.yellow}╔══${C.reset}${C.bold}${title}${C.reset}${C.yellow}${'═'.repeat(fill)}╗${C.reset}`;
  const bottom = `  ${C.yellow}╚${'═'.repeat(BOX_INNER + 2)}╝${C.reset}`;
  return [
    '',
    top,
    boxLine(`${C.bold}Kortix CLI${C.reset} ${C.dim}v${current}${C.reset}  ${C.yellow}→${C.reset}  ${C.green}${C.bold}${latestDisplay}${C.reset}`),
    boxLine(`Run  ${C.cyan}kortix update${C.reset}  to upgrade.`),
    bottom,
  ].join('\n');
}

function renderLine(current: string, latestDisplay: string): string {
  return (
    `  ${C.yellow}!${C.reset}  ${C.yellow}Update available: v${current} → ${latestDisplay} — run${C.reset} ` +
    `${C.cyan}kortix update${C.reset}`
  );
}

export interface UpdateNoticeOptions {
  /** Hit the network when the cache is stale. Bare `kortix` does; subcommands don't. */
  allowFetch: boolean;
  /** Box for the bare landing screen, single line for subcommands. */
  style: 'box' | 'line';
}

/**
 * Returns a rendered update notice (box or single line), or null when up to
 * date / disabled / no release info available. Never throws.
 */
export async function getUpdateNotice(
  current: string,
  opts: UpdateNoticeOptions,
): Promise<string | null> {
  try {
    if (isDisabled(current)) return null;
    const cur = parseVersion(current);
    if (!cur) return null;

    const latestTag = await resolveLatestTag(opts.allowFetch);
    if (!latestTag) return null;
    const latest = parseVersion(latestTag);
    if (!latest) return null;
    if (compareVersions(latest, cur) <= 0) return null;

    const latestDisplay = latestTag.startsWith('v') ? latestTag : `v${latestTag}`;
    return opts.style === 'box'
      ? renderBox(current, latestDisplay)
      : renderLine(current, latestDisplay);
  } catch {
    return null;
  }
}
