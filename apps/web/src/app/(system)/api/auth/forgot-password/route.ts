import { NextRequest, NextResponse } from 'next/server';

import { forgotPassword } from '@/app/[locale]/(auth)/auth/actions';
import {
  AUTH_ROUTE_TIMEOUT_MS,
  AUTH_TIMEOUT_MESSAGE,
  AUTH_UNEXPECTED_MESSAGE,
  sameOriginRequest,
  settleWithin,
} from '@/lib/auth/submit-auth';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// POST /api/auth/forgot-password — the bounded transport for the auth page's
// password-reset submit. Same rationale as /api/auth/password and
// /api/auth/send-code: the browser needs an abortable, retryable submit, and
// the form is forwarded unchanged to the exact action the old direct call used.
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  if (!sameOriginRequest(req)) {
    return NextResponse.json({ message: AUTH_UNEXPECTED_MESSAGE }, { status: 403 });
  }
  try {
    const formData = await req.formData();
    const result = await settleWithin(forgotPassword(null, formData), AUTH_ROUTE_TIMEOUT_MS, () => ({
      message: AUTH_TIMEOUT_MESSAGE,
      status: 503,
    }));
    // Same contract as send-code: the action labels a refused send 429 (rate
    // limit) or 400/503 (ordinary rejection, timed-out upstream); the route
    // relays that status instead of answering every outcome 200 — the browser
    // must be able to tell a refusal apart from success (KRTX-2049).
    const status =
      'success' in result && result.success ? 200 : 'status' in result ? result.status : 400;
    return NextResponse.json(result, {
      status,
      headers: status === 429 ? { 'Retry-After': '3600' } : undefined,
    });
  } catch (err) {
    console.error('[api/auth/forgot-password] POST error:', err);
    return NextResponse.json({ message: AUTH_UNEXPECTED_MESSAGE }, { status: 500 });
  }
}
