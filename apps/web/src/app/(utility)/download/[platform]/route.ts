import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { APP_STORE_URL, GOOGLE_PLAY_URL } from '@kortix/ui/internal/lib/mobile-store-urls';

import {
  detectPlatform,
  isMobilePlatform,
  normalizePlatform,
} from '@/features/marketing/download/detect-os';
import {
  deploymentChannel,
  desktopReleasesPage,
  getDesktopRelease,
  pickDesktopAsset,
} from '@/features/marketing/download/releases';

/**
 * Desktop installer redirector — the machine half of /download.
 *
 *   /download/macos   → latest universal .dmg
 *   /download/windows → latest .exe
 *   /download/linux   → latest x86_64 .AppImage
 *   /download/ios     → App Store listing
 *   /download/android → Google Play listing
 *   /download/mobile  → the store for the requesting phone, else /download.
 *                       The store QR code (`MobileStoreQr`) encodes this URL.
 *
 * dev.kortix.com and staging.kortix.com serve their own channel build
 * (desktop-dev-latest, desktop-staging-latest), which opens that deployment.
 *
 * These are hand-writable URLs on purpose: they go in emails, docs, and support
 * replies. Asset resolution is shared with the /download page, so the file a
 * visitor receives is always the one the page advertised.
 *
 * Anything unresolvable falls back to the releases page rather than erroring —
 * a visitor who wanted software should always land somewhere they can get it.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ platform: string }> },
) {
  const { platform } = await params;
  if (platform.toLowerCase() === 'mobile') {
    const detected = detectPlatform(request.headers.get('user-agent'));
    if (detected === 'ios') return NextResponse.redirect(APP_STORE_URL, 302);
    if (detected === 'android') return NextResponse.redirect(GOOGLE_PLAY_URL, 302);
    return NextResponse.redirect(new URL('/download', request.url), 302);
  }

  const os = normalizePlatform(platform);
  if (os === 'ios') return NextResponse.redirect(APP_STORE_URL, 302);
  if (os === 'android') return NextResponse.redirect(GOOGLE_PLAY_URL, 302);
  const channel = deploymentChannel();
  const fallback = desktopReleasesPage(channel);

  // Mobile values never reach pickDesktopAsset. That function's isInstaller()
  // ends in an unguarded `return n.endsWith('.appimage')` fallthrough, so a
  // phone platform would get a Linux AppImage. The returns above cover ios and
  // android; this guard keeps any future mobile alias out too.
  if (!os || isMobilePlatform(os)) return NextResponse.redirect(fallback, 302);

  const release = await getDesktopRelease(channel);
  const asset = release ? pickDesktopAsset(release.assets, os) : undefined;
  return NextResponse.redirect(asset?.url ?? fallback, 302);
}
