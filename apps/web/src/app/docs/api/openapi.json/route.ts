import { NextResponse } from 'next/server';

const SPEC_URL = 'https://api.kortix.com/v1/openapi.json';

export async function GET() {
  const upstream = await fetch(SPEC_URL, { next: { revalidate: 300 } });
  if (!upstream.ok) {
    return NextResponse.json(
      { error: 'Failed to load the OpenAPI spec.' },
      { status: 502 },
    );
  }
  const spec = await upstream.json();
  return NextResponse.json(spec, {
    headers: { 'Cache-Control': 'public, max-age=300' },
  });
}
