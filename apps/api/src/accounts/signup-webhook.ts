// Signup → one signed `account.signup` event to SIGNUP_WEBHOOK_URL.
//
// The receiver is a Kortix project webhook trigger (the sales factory), which
// verifies `X-Kortix-Signature` and dedupes on `X-Kortix-Delivery-Id`. Inert
// until SIGNUP_WEBHOOK_URL and SIGNUP_WEBHOOK_SECRET are both set.
//
// Fire-and-forget from bootstrapPersonalAccount: a failed delivery must never
// affect signup, so failures are logged (user id only) and dropped after a
// few retries.

import { createHmac } from 'node:crypto';
import { WEBHOOK_DELIVERY_ID_HEADER, WEBHOOK_SIGNATURE_HEADER } from '@kortix/shared';

import { config } from '../config';
import { logger } from '../lib/logger';
import { getSupabase } from '../shared/supabase';
import { classifyEmailKind, emailDomain } from './personal-email';

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 2_000;

interface Signup {
  userId: string;
  email: string;
  name: string | null;
}

export function buildSignupEvent(
  s: Signup & { authProvider: string | null; createdAt: Date },
) {
  return {
    event: 'account.signup',
    user_id: s.userId,
    email: s.email,
    email_kind: classifyEmailKind(s.email),
    email_domain: emailDomain(s.email),
    name: s.name,
    auth_provider: s.authProvider,
    created_at: s.createdAt.toISOString(),
  };
}

/** `google`, `github`, `email`, … from the auth user. Best effort. */
async function authProvider(userId: string): Promise<string | null> {
  try {
    const { data } = await getSupabase().auth.admin.getUserById(userId);
    return data?.user?.app_metadata?.provider ?? null;
  } catch {
    return null;
  }
}

export async function sendSignupWebhook(
  signup: Signup,
  retryBaseMs: number = RETRY_BASE_MS,
  lookupProvider: (userId: string) => Promise<string | null> = authProvider,
): Promise<boolean> {
  const url = config.SIGNUP_WEBHOOK_URL;
  const secret = config.SIGNUP_WEBHOOK_SECRET;
  if (!url || !secret) return false;

  const body = JSON.stringify(
    buildSignupEvent({
      ...signup,
      authProvider: await lookupProvider(signup.userId),
      createdAt: new Date(),
    }),
  );
  const headers = {
    'Content-Type': 'application/json',
    [WEBHOOK_SIGNATURE_HEADER]: `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
    [WEBHOOK_DELIVERY_ID_HEADER]: `account.signup:${signup.userId}`,
  };

  let lastError = 'unknown error';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return true;
      lastError = `HTTP ${res.status}`;
      // 4xx (bad secret, unknown trigger) won't heal on retry.
      if (res.status < 500) break;
    } catch (err) {
      lastError = (err as Error).message;
    }
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, attempt * retryBaseMs));
    }
  }

  logger.warn('[accounts/signup-webhook] delivery failed', { userId: signup.userId, error: lastError });
  return false;
}
