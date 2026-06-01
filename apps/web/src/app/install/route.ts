import { NextRequest, NextResponse } from 'next/server';

// Serves the Kortix CLI installer. Hit via:
//   curl -fsSL https://kortix.com/install | bash
//
// ALWAYS serves the canonical script from the `main` branch on GitHub raw.
// We deliberately do NOT prefer a locally-bundled copy: a stale build (e.g. an
// old production deployment) would otherwise serve an out-of-date — or entirely
// wrong — script. main/scripts/install.sh is the single source of truth.
//
// Browsers hitting this URL (Accept: text/html) get a 302 redirect to
// the script's GitHub page so a human can review it before running.

const REPO_URL = 'https://github.com/kortix-ai/suna';
const REPO_SCRIPT_URL = `${REPO_URL}/blob/main/scripts/install.sh`;
const RAW_SCRIPT_URL = 'https://raw.githubusercontent.com/kortix-ai/suna/main/scripts/install.sh';

function prefersHtml(request: NextRequest): boolean {
  const accept = request.headers.get('accept') || '';
  return accept.includes('text/html');
}

function scriptHeaders(upstreamHeaders: Headers): Headers {
  const headers = new Headers(upstreamHeaders);
  headers.set('Content-Type', 'text/x-shellscript; charset=utf-8');
  headers.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120');
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('X-Kortix-Install-Source', RAW_SCRIPT_URL);
  return headers;
}

export async function GET(request: NextRequest) {
  if (prefersHtml(request)) {
    return NextResponse.redirect(REPO_SCRIPT_URL, 302);
  }

  const upstream = await fetch(RAW_SCRIPT_URL, {
    headers: {
      'User-Agent': 'kortix-install-route',
    },
    next: {
      revalidate: 300,
    },
  });

  if (!upstream.ok) {
    return new NextResponse(`Failed to fetch installer from ${RAW_SCRIPT_URL}`, { status: 502 });
  }

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: scriptHeaders(upstream.headers),
  });
}
