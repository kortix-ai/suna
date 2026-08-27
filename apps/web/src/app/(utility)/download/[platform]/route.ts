import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { isMobilePlatform, normalizePlatform } from '@/features/marketing/download/detect-os';
import {
  RELEASES_PAGE,
  getLatestRelease,
  pickDesktopAsset,
} from '@/features/marketing/download/releases';

/**
 * Desktop installer redirector — the machine half of /download.
 *
 *   /download/macos   → latest universal .dmg
 *   /download/windows → latest .exe
 *   /download/linux   → latest x86_64 .AppImage
 *
 * These are hand-writable URLs on purpose: they go in emails, docs, and support
 * replies. Asset resolution is shared with the /download page, so the file a
 * visitor receives is always the one the page advertised.
 *
 * Anything unresolvable falls back to the releases page rather than erroring —
 * a visitor who wanted software should always land somewhere they can get it.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ platform: string }> },
) {
  const { platform } = await params;
  const os = normalizePlatform(platform);

  // Mobile values are rejected here, not left to pickDesktopAsset. That
  // function's isInstaller() ends in an unguarded `return n.endsWith('.appimage')`
  // fallthrough, so /download/ios would hand an iPhone visitor a Linux AppImage.
  // Phones are served by the App Store and Play Store links on the page.
  if (!os || isMobilePlatform(os)) return NextResponse.redirect(RELEASES_PAGE, 302);

  const release = await getLatestRelease();
  const asset = release ? pickDesktopAsset(release.assets, os) : undefined;
  return NextResponse.redirect(asset?.url ?? RELEASES_PAGE, 302);
}
