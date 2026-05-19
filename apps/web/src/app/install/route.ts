import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';

// Serves the Kortix CLI installer. Hit via:
//   curl -fsSL https://kortix.com/install | bash
//
// Looks for `scripts/install.sh` locally first (so dev environments
// serve the in-tree version), then falls back to fetching it from the
// `main` branch on GitHub.
//
// Browsers hitting this URL (Accept: text/html) get a 302 redirect to
// the script's GitHub page so a human can review it before running.

const REPO_URL = 'https://github.com/kortix-ai/suna';
const REPO_SCRIPT_URL = `${REPO_URL}/blob/main/scripts/install.sh`;
const RAW_SCRIPT_URL = 'https://raw.githubusercontent.com/kortix-ai/suna/main/scripts/install.sh';
const LOCAL_SCRIPT_CANDIDATES = [
  path.join(process.cwd(), '../../scripts/install.sh'),
  path.join(process.cwd(), '../scripts/install.sh'),
  path.join(process.cwd(), 'scripts/install.sh'),
];

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

async function readLocalInstaller(): Promise<string | null> {
  for (const candidate of LOCAL_SCRIPT_CANDIDATES) {
    try {
      return await readFile(candidate, 'utf8');
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

export async function GET(request: NextRequest) {
  if (prefersHtml(request)) {
    return NextResponse.redirect(REPO_SCRIPT_URL, 302);
  }

  const localInstaller = await readLocalInstaller();
  if (localInstaller !== null) {
    return new NextResponse(localInstaller, {
      status: 200,
      headers: scriptHeaders(new Headers()),
    });
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
