import { submitDemoRequest } from '@kortix/sdk';
import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

import { clientIp, consumeRateLimit } from '@/lib/seo/rate-limit';

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
//      API's email-provider credentials (from AWS Secrets Manager) — the Vercel
//      frontend never needs the secret.
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

function anonClient() {
  // Runtime (non-NEXT_PUBLIC_) vars first — NEXT_PUBLIC_ are inlined at build
  // time and hold placeholders in Docker builds. Mirrors lib/supabase/server.ts.
  const url =
    process.env.SUPABASE_SERVER_URL ||
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
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

// Notify us of every submission via the API (which holds the email-provider creds).
// Best-effort: never throws, never blocks the user's flow on a failed email.
async function notify(body: Record<string, unknown>): Promise<void> {
  try {
    await submitDemoRequest(
      {
        name: typeof body.name === 'string' ? body.name : undefined,
        email: String(body.email ?? '').trim(),
        company_name: typeof body.company_name === 'string' ? body.company_name : undefined,
        company_size: typeof body.company_size === 'string' ? body.company_size : undefined,
        goal: typeof body.goal === 'string' ? body.goal : undefined,
        qualified: typeof body.qualified === 'boolean' ? body.qualified : undefined,
        source: typeof body.source === 'string' ? body.source : undefined,
      },
      {
        backendUrl: backendUrl(),
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch (err) {
    console.warn('[api/demo-request] notify failed:', (err as Error).message);
  }
}

const MAX_BODY_BYTES = 8 * 1024;
const MAX_FIELD_CHARS = 2000;
const SUBMISSIONS_PER_MINUTE = 5;
// The only keys the forms send. Anything else is dropped, never stored.
const STRING_FIELDS = [
  'name',
  'email',
  'company_name',
  'company_size',
  'goal',
  'source',
  'opening',
  'owned',
  'link',
] as const;

export async function POST(request: NextRequest) {
  const rate = consumeRateLimit(`demo-request:${clientIp(request)}`, SUBMISSIONS_PER_MINUTE);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'Too many requests' },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.max(1, Math.ceil((rate.resetsAt - Date.now()) / 1000))) },
      },
    );
  }

  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Body too large' }, { status: 413 });
  }
  let raw: Record<string, unknown>;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: 'Body too large' }, { status: 413 });
    }
    raw = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }
  const body: Record<string, unknown> = {};
  for (const key of STRING_FIELDS) {
    if (typeof raw[key] === 'string') body[key] = (raw[key] as string).slice(0, MAX_FIELD_CHARS);
  }
  if (typeof raw.qualified === 'boolean') body.qualified = raw.qualified;

  if (!isValidEmail(String(body.email ?? '').trim())) {
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
