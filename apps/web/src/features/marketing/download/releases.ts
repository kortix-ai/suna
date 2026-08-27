/**
 * The single source of truth for "what can you actually download right now".
 *
 * BOTH the /download page and the /download/<platform> redirect handlers import
 * this module. That is the point: the size and version the page prints and the
 * bytes the button delivers are resolved by the same function, so they cannot
 * drift apart.
 *
 * Verified against release v0.11.0 (2026-07-28):
 *   macOS   Kortix-<v>-universal.dmg          (universal: Apple Silicon + Intel)
 *   Windows Kortix-Setup-<v>.exe
 *   Linux   Kortix-<v>-x86_64.AppImage        (x86_64 ONLY — no arm64 build)
 *   CLI     kortix-{darwin,linux}-{arm64,x64} (no Windows binary)
 */

import type { DesktopOs } from './detect-os';

const REPO = 'kortix-ai/suna';
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;

/** Where every download falls back to when the API is unreachable. */
export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

export type ReleaseAsset = { name: string; url: string; size: number };
export type Release = { version: string; assets: ReleaseAsset[] };
export type CliArch = 'arm64' | 'x64';

/**
 * Whether an asset is the installer for `os`. GitHub publishes `.blockmap`
 * update deltas, `.zip` updater payloads, `latest*.yml`, and `SHA256SUMS`
 * alongside the installers — none of those may ever be handed to a visitor.
 */
function isInstaller(name: string, os: DesktopOs): boolean {
  const n = name.toLowerCase();
  if (n.endsWith('.blockmap')) return false;
  if (os === 'macos') return n.endsWith('.dmg');
  if (os === 'windows') return n.endsWith('.exe') || n.endsWith('.msi');
  return n.endsWith('.appimage');
}

/**
 * Resolve the desktop installer. macOS ships one universal .dmg today, but if a
 * release ever carries per-arch builds we take the universal one rather than
 * whichever .dmg happens to sort first — that was the old Intel-download bug.
 */
export function pickDesktopAsset(assets: ReleaseAsset[], os: DesktopOs): ReleaseAsset | undefined {
  const matches = assets.filter((a) => isInstaller(a.name, os));
  if (os !== 'macos' || matches.length <= 1) return matches[0];
  return matches.find((a) => a.name.toLowerCase().includes('universal')) ?? matches[0];
}

/** CLI binaries are named `kortix-<goos>-<arch>`. Windows publishes none. */
export function pickCliAsset(
  assets: ReleaseAsset[],
  os: DesktopOs,
  arch: CliArch,
): ReleaseAsset | undefined {
  if (os === 'windows') return undefined;
  const target = `kortix-${os === 'macos' ? 'darwin' : 'linux'}-${arch}`;
  return assets.find((a) => a.name.toLowerCase() === target);
}

/** Whole megabytes — the page never needs more precision than that. */
export function formatSize(bytes: number): string {
  if (!bytes) return '';
  return `${Math.round(bytes / 1_048_576)} MB`;
}

type GithubAsset = { name?: string; browser_download_url?: string; size?: number };

/**
 * Fetch the newest release. Returns null on any failure — rate limit, network,
 * malformed payload. Callers MUST degrade rather than error: the page hides its
 * metadata line and the redirect handlers fall back to RELEASES_PAGE. A visitor
 * never sees a broken button because GitHub was slow.
 *
 * The 10-minute revalidate keeps a burst of clicks off GitHub's rate limit.
 */
export async function getLatestRelease(): Promise<Release | null> {
  try {
    const res = await fetch(LATEST_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'kortix-download' },
      next: { revalidate: 600 },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { tag_name?: string; assets?: GithubAsset[] };
    const assets: ReleaseAsset[] = (data.assets ?? [])
      .filter((a): a is GithubAsset & { name: string; browser_download_url: string } =>
        Boolean(a.name && a.browser_download_url),
      )
      .map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size ?? 0 }));
    if (!assets.length) return null;
    return { version: (data.tag_name ?? '').replace(/^v/, ''), assets };
  } catch {
    return null;
  }
}
