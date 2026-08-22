import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { RELEASES_PAGE, getLatestRelease } from '@/features/marketing/download/releases';

/**
 * CLI binary redirector: /download/cli/darwin-arm64 → the `kortix-darwin-arm64`
 * asset. The published binaries are named exactly `kortix-<goos>-<arch>`, so the
 * URL segment IS the target triple and no mapping table is needed.
 *
 * Only the four published targets resolve; everything else falls back to the
 * releases page. There is no Windows CLI binary — the install script is
 * bash-only, and Windows users are pointed at WSL.
 */
const TARGETS = new Set(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']);

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ target: string }> },
) {
  const { target } = await params;
  const normalized = target.toLowerCase();
  if (!TARGETS.has(normalized)) return NextResponse.redirect(RELEASES_PAGE, 302);

  const release = await getLatestRelease();
  const asset = release?.assets.find((a) => a.name.toLowerCase() === `kortix-${normalized}`);
  return NextResponse.redirect(asset?.url ?? RELEASES_PAGE, 302);
}
