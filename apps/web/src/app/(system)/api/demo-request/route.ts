import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { sendDemoRequestNotification, type DemoRequestLead } from './notify-email';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// ---------------------------------------------------------------------------
// POST /api/demo-request — public lead capture for the /contact qualifier.
//
// Schema-agnostic: the whole submission is stored as one JSON blob in
// public.contact_forms (RLS allows INSERT only — see migration 109). No DB
// migration needed when a form's fields change.
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

  // Store the whole submission verbatim, plus a couple of server-side fields.
  const userAgent = request.headers.get('user-agent')?.slice(0, 500) ?? null;
  const data = {
    ...body,
    form: body.source ?? 'contact',
    user_agent: userAgent,
  };

  // Notify us of every submission — the first-step details, before/whether or
  // not the lead goes on to book a Cal slot. Awaited (never throws, 10s cap) so
  // the send actually runs in the serverless function; a skipped/failed email
  // must not fail the user's flow, so we only log it.
  const lead: DemoRequestLead = {
    name: typeof body.name === 'string' ? body.name : undefined,
    email: String(body.email).trim(),
    company_name: typeof body.company_name === 'string' ? body.company_name : undefined,
    company_size: typeof body.company_size === 'string' ? body.company_size : undefined,
    goal: typeof body.goal === 'string' ? body.goal : undefined,
    qualified: typeof body.qualified === 'boolean' ? body.qualified : undefined,
    source: typeof body.source === 'string' ? body.source : undefined,
    user_agent: userAgent,
  };
  const notify = await sendDemoRequestNotification(lead);
  if (!notify.ok && !('skipped' in notify && notify.skipped)) {
    console.error('[api/demo-request] notification not sent:', notify);
  }

  const supabase = anonClient();
  if (!supabase) {
    // Don't fail the user's flow if capture is misconfigured — log and move on.
    console.error('[api/demo-request] Supabase env missing; lead not persisted');
    return NextResponse.json({ ok: true, persisted: false });
  }

  const { error } = await supabase.from('contact_forms').insert({ data });
  if (error) {
    console.error('[api/demo-request] insert failed:', error.message);
    return NextResponse.json({ ok: true, persisted: false });
  }

  return NextResponse.json({ ok: true, persisted: true });
}
