import { NextResponse } from 'next/server';

export const revalidate = 300; // cache for 5 minutes

export async function GET() {
  try {
    const res = await fetch('https://api.github.com/repos/kortix-ai/suna', {
      headers: { 'Accept': 'application/vnd.github.v3+json' },
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);

    const data = await res.json();
    return NextResponse.json({ stars: data.stargazers_count });
  } catch {
    return NextResponse.json({ stars: 20000 });
  }
}
