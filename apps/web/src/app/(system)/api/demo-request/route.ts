import { NextRequest, NextResponse } from 'next/server';
import { submitDemoRequest } from '@kortix/sdk';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// ---------------------------------------------------------------------------
// POST /api/demo-request — public lead capture for the /contact qualifier and
// the /careers application form.
//
// A thin forwarder: both side effects belong to the API's public
// POST /v1/system/demo-request, which persists the submission into
// public.contact_forms and emails the internal notification. Keeping both
// server-side means this Vercel frontend needs neither database nor
// email-provider credentials. Neither side effect may fail the user's flow, so
// a backend failure is logged here and still answered 200.
// ---------------------------------------------------------------------------

function isValidEmail(value: string): boolean {
  if (value.length === 0 || value.length > 254) return false;
  for (const char of value) {
    if (char === ' ' || char === '\t' || char === '\r' || char === '\n') return false;
  }
  const at = value.lastIndexOf('@');
  if (at <= 0 || at !== value.indexOf('@') || at === value.length - 1) return false;
  const domain = value.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  return dot > 0 && dot < domain.length - 1;
}

function backendUrl() {
  return (
    process.env.BACKEND_URL ||
    process.env.KORTIX_PUBLIC_BACKEND_URL ||
    process.env.NEXT_PUBLIC_BACKEND_URL ||
    'http://localhost:8008/v1'
  ).replace(/\/$/, '');
}

// The API validates the fields it knows. Trim them to its documented limits and
// drop wrong-typed ones so a single malformed field can never 400 the request
// and cost us the whole lead. Every other key is forwarded untouched — the
// contact_forms row stores the submission verbatim.
const TEXT_LIMITS: Record<string, number> = {
  name: 200,
  company_name: 200,
  company_size: 50,
  goal: 2000,
  source: 100,
};

function normalize(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  for (const [key, limit] of Object.entries(TEXT_LIMITS)) {
    if (!(key in out)) continue;
    if (typeof out[key] === 'string') out[key] = (out[key] as string).slice(0, limit);
    else delete out[key];
  }
  if ('qualified' in out && typeof out.qualified !== 'boolean') delete out.qualified;
  return out;
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const email = String(body.email ?? '').trim();
  if (!isValidEmail(email)) {
    return NextResponse.json({ error: 'Invalid email' }, { status: 400 });
  }

  // Awaited before returning so the call isn't dropped when the serverless
  // function freezes. Best-effort: never throws, never blocks the user's flow.
  let persisted = false;
  try {
    const result = (await submitDemoRequest(
      {
        ...normalize(body),
        email,
        // Sent explicitly: the API sees this Next.js server as its client, so
        // its own header would record the server, not the visitor's browser.
        user_agent: request.headers.get('user-agent')?.slice(0, 500) ?? null,
      },
      {
        backendUrl: backendUrl(),
        signal: AbortSignal.timeout(10_000),
      },
    )) as { persisted?: boolean } | null;
    persisted = result?.persisted === true;
  } catch (err) {
    console.warn('[api/demo-request] submit failed:', (err as Error).message);
  }

  return NextResponse.json({ ok: true, persisted });
}
