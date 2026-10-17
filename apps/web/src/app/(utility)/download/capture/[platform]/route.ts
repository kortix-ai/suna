import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isMobilePlatform, normalizePlatform } from '@/features/marketing/download/detect-os';
import {
  getCaptureDevRelease,
  getLatestCaptureRelease,
  pickCaptureAsset,
} from '@/features/marketing/download/releases';

/**
 * Kortix Capture installer redirector: /download/capture/windows → the .msi,
 * /macos → the .pkg, /linux → the .deb of the newest vX.Y.Z Release that carries them.
 * Kortix Capture is its own app, installed apart from the Kortix app. A release without its
 * installers, or a platform it does not ship for, lands on the install docs.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ platform: string }> }) {
  const os = normalizePlatform((await params).platform);
  if (!os || isMobilePlatform(os)) return toDocs();
  const release = isDevDeployment() ? await getCaptureDevRelease() : await getLatestCaptureRelease();
  const asset = release ? pickCaptureAsset(release.assets, os) : undefined;
  return asset ? NextResponse.redirect(asset.url, 302) : toDocs();
}

/** The install docs, by a relative Location: behind the load balancer request.url names the
 *  task's internal host (ip-10-…compute.internal:3000), which no browser can reach. */
function toDocs(): Response {
  return new Response(null, { status: 302, headers: { Location: '/docs/capture#install-kortix-capture' } });
}

/** dev.kortix.com (its backend is dev-api) serves the dev channel, whose installers sync to
 *  dev-api. Production, staging and every self-hosted instance serve the newest vX.Y.Z. */
function isDevDeployment(): boolean {
  try {
    return new URL(process.env.NEXT_PUBLIC_BACKEND_URL ?? '').hostname === 'dev-api.kortix.com';
  } catch {
    return false;
  }
}
