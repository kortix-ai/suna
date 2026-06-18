import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Desktop app installer redirector — the download equivalent of `/install`.
 *
 *   /download                  → latest installer for the visitor's OS
 *   /download?platform=macos   → latest macOS .dmg
 *   /download?platform=windows → latest Windows .msi
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

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const platform = normalizePlatform(
    searchParams.get('platform'),
    request.headers.get('user-agent') || '',
  );

  try {
    const res = await fetch(LATEST_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'kortix-download' },
      // Cache the API lookup so we don't hit GitHub's rate limit on every click.
      next: { revalidate: 600 },
    });
    if (res.ok) {
      const data = (await res.json()) as {
        assets?: { name: string; browser_download_url: string }[];
      };
      const asset = (data.assets || []).find((a) => assetMatches(a.name, platform));
      if (asset?.browser_download_url) {
        return NextResponse.redirect(asset.browser_download_url, 302);
      }
    }
  } catch {
    // fall through to the releases page
  }

  return NextResponse.redirect(RELEASES_PAGE, 302);
}
