import { NextRequest, NextResponse } from 'next/server';

import { sendEmailCode } from '@/app/[locale]/(auth)/auth/actions';
import {
  AUTH_ROUTE_TIMEOUT_MS,
  AUTH_TIMEOUT_MESSAGE,
  AUTH_UNEXPECTED_MESSAGE,
  sameOriginRequest,
  settleWithin,
} from '@/lib/auth/submit-auth';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// POST /api/auth/send-code — the bounded transport for the auth page's
// "email me a sign-in link" submit. Server actions are neither abortable nor
// retryable (a hung POST head-of-line blocks every later action in Next's
// serial client queue), so the page calls this handler with a browser-side
// deadline instead. The form is forwarded unchanged to the same `sendEmailCode`
// action the old direct call used — one implementation, two transports.
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  if (!sameOriginRequest(req)) {
    return NextResponse.json({ message: AUTH_UNEXPECTED_MESSAGE }, { status: 403 });
  }
  try {
    const formData = await req.formData();
    // `Promise.resolve` flattens the union-of-actions call (Promise<A> | Promise<B>)
    // into one Promise<A | B> so settleWithin's inference sees the whole union.
    const result = await settleWithin(Promise.resolve(sendEmailCode(null, formData)), AUTH_ROUTE_TIMEOUT_MS, () => ({
      message: AUTH_TIMEOUT_MESSAGE,
    }));
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ message: AUTH_UNEXPECTED_MESSAGE }, { status: 500 });
  }
}
