import { NextRequest, NextResponse } from 'next/server';

import { signInWithPassword, signUpWithPassword } from '@/app/[locale]/(auth)/auth/actions';
import {
  AUTH_ROUTE_TIMEOUT_MS,
  AUTH_TIMEOUT_MESSAGE,
  AUTH_UNEXPECTED_MESSAGE,
  sameOriginRequest,
  settleWithin,
} from '@/lib/auth/submit-auth';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// POST /api/auth/password?intent=signup|signin — the bounded transport for the
// auth page's password submit. Same rationale as /api/auth/send-code: the
// browser needs an abortable, retryable submit, and the form is forwarded
// unchanged to the exact action the old direct call used.
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  if (!sameOriginRequest(req)) {
    return NextResponse.json({ message: AUTH_UNEXPECTED_MESSAGE }, { status: 403 });
  }
  try {
    const formData = await req.formData();
    const intent = req.nextUrl.searchParams.get('intent') === 'signin' ? 'signin' : 'signup';
    const action = intent === 'signin' ? signInWithPassword : signUpWithPassword;
    // `Promise.resolve` flattens the union-of-actions call (Promise<A> | Promise<B>)
    // into one Promise<A | B> so settleWithin's inference sees the whole union.
    const result = await settleWithin(Promise.resolve(action(null, formData)), AUTH_ROUTE_TIMEOUT_MS, () => ({
      message: AUTH_TIMEOUT_MESSAGE,
    }));
    return NextResponse.json(result);
  } catch (err) {
    console.error('[api/auth/password] POST error:', err);
    return NextResponse.json({ message: AUTH_UNEXPECTED_MESSAGE }, { status: 500 });
  }
}
