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
    }));
    return NextResponse.json(result);
  } catch (err) {
    console.error('[api/auth/forgot-password] POST error:', err);
    return NextResponse.json({ message: AUTH_UNEXPECTED_MESSAGE }, { status: 500 });
  }
}
