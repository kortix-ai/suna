import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Desktop app installer redirector — the download equivalent of `/install`.
 *
 *   /download                  → latest installer for the visitor's OS
 *   /download?platform=macos   → latest macOS .dmg (universal: Apple Silicon + Intel)
 *   /download?platform=windows → latest Windows .exe
 *   /download?platform=linux   → latest Linux .AppImage
 *
 * Resolves the newest GitHub release's matching asset so links never carry a
 * version and never 404 on a new release. Falls back to the releases page.
 */

const REPO = 'kortix-ai/suna';
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;

type Platform = 'macos' | 'windows' | 'linux';

function normalizePlatform(raw: string | null, ua: string): Platform {
  const q = (raw || '').toLowerCase();
  if (['mac', 'macos', 'osx', 'darwin', 'apple'].includes(q)) return 'macos';
  if (['win', 'windows'].includes(q)) return 'windows';
  if (q === 'linux') return 'linux';

  const u = ua.toLowerCase();
  if (u.includes('windows')) return 'windows';
  if (u.includes('mac') || u.includes('darwin')) return 'macos';
  if (u.includes('linux') && !u.includes('android')) return 'linux';
  return 'macos';
}

function assetMatches(name: string, platform: Platform): boolean {
  const n = name.toLowerCase();
  if (platform === 'macos') return n.endsWith('.dmg');
  if (platform === 'windows') return n.endsWith('.msi') || n.endsWith('.exe');
  if (platform === 'linux') return n.endsWith('.appimage');
  return false;
}

type Asset = { name: string; browser_download_url: string };

/**
 * Pick the best asset for the platform. macOS ships a single universal .dmg, but
 * if a release ever has per-arch builds we prefer the universal one, then the
 * UA-hinted arch, then arm64 (never blindly the first .dmg — that was the Intel
 * download bug). macOS user-agents lie about arch (always "Intel"), so an
 * explicit ?arch=arm64|x64 wins.
 */
function pickAsset(assets: Asset[], platform: Platform, archHint: string): Asset | undefined {
  const matches = assets.filter((a) => assetMatches(a.name, platform));
  if (matches.length <= 1 || platform !== 'macos') return matches[0];
  const lc = (a: Asset) => a.name.toLowerCase();
  return (
    matches.find((a) => lc(a).includes('universal')) ||
    (archHint === 'x64' && matches.find((a) => /x64|x86_64|intel/.test(lc(a)))) ||
    matches.find((a) => /arm64|aarch64|apple|silicon/.test(lc(a))) ||
    matches[0]
  );
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const platform = normalizePlatform(
    searchParams.get('platform'),
    request.headers.get('user-agent') || '',
  );
  const archHint = (searchParams.get('arch') || '').toLowerCase();

  try {
    const res = await fetch(LATEST_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'kortix-download' },
      // Cache the API lookup so we don't hit GitHub's rate limit on every click.
      next: { revalidate: 600 },
    });
    if (res.ok) {
      const data = (await res.json()) as { assets?: Asset[] };
      const asset = pickAsset(data.assets || [], platform, archHint);
      if (asset?.browser_download_url) {
        return NextResponse.redirect(asset.browser_download_url, 302);
      }
    }
  } catch {
    // fall through to the releases page
  }

  return NextResponse.redirect(RELEASES_PAGE, 302);
}
