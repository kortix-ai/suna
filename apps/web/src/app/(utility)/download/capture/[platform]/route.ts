import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isMobilePlatform, normalizePlatform } from '@/features/marketing/download/detect-os';
import { getLatestCaptureRelease, pickCaptureAsset } from '@/features/marketing/download/releases';

/**
 * Kortix Capture installer redirector: /download/capture/windows → the .msi,
 * /macos → the .pkg, /linux → the .deb of the newest vX.Y.Z Release that carries them.
 * Kortix Capture is its own app, installed apart from the Kortix app. A release without its
 * installers, or a platform it does not ship for, lands on the install docs.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ platform: string }> }) {
  const docs = new URL('/docs/capture#install-kortix-capture', request.url);
  const os = normalizePlatform((await params).platform);
  if (!os || isMobilePlatform(os)) return NextResponse.redirect(docs, 302);
  const release = await getLatestCaptureRelease();
  const asset = release ? pickCaptureAsset(release.assets, os) : undefined;
  return NextResponse.redirect(asset?.url ?? docs, 302);
}
