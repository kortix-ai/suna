import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// ---------------------------------------------------------------------------
// POST /api/demo-request — public lead capture for the /contact qualifier.
//
// Two best-effort side effects, neither of which may fail the user's flow:
//   1. Persist the whole submission as one JSON blob in public.contact_forms
//      (RLS allows INSERT only — see migration 109). Schema-agnostic: no DB
//      migration needed when a form's fields change.
//   2. Fire an internal notification email by calling the API's public
//      POST /v1/system/demo-request. The email is sent API-side so it uses the
//      API's Mailtrap credentials (from AWS Secrets Manager) — the Vercel
//      frontend never needs the secret.
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function anonClient() {
  // Runtime (non-NEXT_PUBLIC_) vars first — NEXT_PUBLIC_ are inlined at build
  // time and hold placeholders in Docker builds. Mirrors lib/supabase/server.ts.
  const url =
    process.env.SUPABASE_SERVER_URL ||
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function backendUrl() {
  return (
    process.env.BACKEND_URL ||
    process.env.KORTIX_PUBLIC_BACKEND_URL ||
    process.env.NEXT_PUBLIC_BACKEND_URL ||
    'http://localhost:8008/v1'
  ).replace(/\/$/, '');
}

// Notify us of every submission via the API (which holds the Mailtrap creds).
// Best-effort: never throws, never blocks the user's flow on a failed email.
async function notify(body: Record<string, unknown>): Promise<void> {
  try {
    const res = await fetch(`${backendUrl()}/system/demo-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: typeof body.name === 'string' ? body.name : undefined,
        email: String(body.email ?? '').trim(),
        company_name: typeof body.company_name === 'string' ? body.company_name : undefined,
        company_size: typeof body.company_size === 'string' ? body.company_size : undefined,
        goal: typeof body.goal === 'string' ? body.goal : undefined,
        qualified: typeof body.qualified === 'boolean' ? body.qualified : undefined,
        source: typeof body.source === 'string' ? body.source : undefined,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error(`[api/demo-request] notify API responded ${res.status}`);
  } catch (err) {
    console.warn('[api/demo-request] notify failed:', (err as Error).message);
  }
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  if (!EMAIL_RE.test(String(body.email ?? '').trim())) {
    return NextResponse.json({ error: 'Invalid email' }, { status: 400 });
  }

  // Fire the notification and persist concurrently — both are best-effort and
  // independent. Await the notification before returning so it isn't dropped
  // when the serverless function freezes.
  const notifyPromise = notify(body);

  // Store the whole submission verbatim, plus a couple of server-side fields.
  const data = {
    ...body,
    form: body.source ?? 'contact',
    user_agent: request.headers.get('user-agent')?.slice(0, 500) ?? null,
  };

  let persisted = false;
  const supabase = anonClient();
  if (!supabase) {
    // Don't fail the user's flow if capture is misconfigured — log and move on.
    console.error('[api/demo-request] Supabase env missing; lead not persisted');
  } else {
    const { error } = await supabase.from('contact_forms').insert({ data });
    if (error) console.error('[api/demo-request] insert failed:', error.message);
    else persisted = true;
  }

  await notifyPromise;
  return NextResponse.json({ ok: true, persisted });
}
