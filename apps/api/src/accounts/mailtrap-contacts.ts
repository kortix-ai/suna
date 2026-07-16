// Signup → Mailtrap contact sync.
//
// The email automations themselves (welcome sequence, founder "book a call"
// follow-up for business-email signups, delays, copy, unsubscribes) live in
// Mailtrap's Automations UI — deliberately NOT in this codebase, so marketing
// can iterate without a deploy. Our only job is to register every new signup
// as a Mailtrap contact on the right lists, which is what the automations
// trigger on:
//
//   MAILTRAP_SIGNUPS_LIST_ID          — every signup
//   MAILTRAP_BUSINESS_SIGNUPS_LIST_ID — signups on a work-email domain
//
// Fire-and-forget from bootstrapPersonalAccount: a failed sync must never
// affect signup, so failures are logged and dropped after a few retries.

import { config } from '../config';
import { classifyEmailKind } from './personal-email';

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 2_000;

export type ContactSyncResult =
  | { ok: true; kind: 'business' | 'personal'; alreadyExisted: boolean }
  | { ok: false; skipped: true; reason: 'not_configured' | 'invalid_email' }
  | { ok: false; skipped?: false; status?: number; error: string };

export function isSignupContactSyncConfigured(): boolean {
  return !!(config.MAILTRAP_API_TOKEN && config.MAILTRAP_ACCOUNT_ID);
}

export interface ContactPlan {
  kind: 'business' | 'personal';
  listIds: number[];
}

// Pure half of the sync — which lists a signup lands on. Split out for tests.
export function planSignupContact(
  email: string,
  cfg: { signupsListId?: string; businessListId?: string },
): ContactPlan {
  const kind = classifyEmailKind(email);
  const listIds = [
    cfg.signupsListId,
    kind === 'business' ? cfg.businessListId : undefined,
  ]
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && v > 0);
  return { kind, listIds };
}

export async function syncSignupContactToMailtrap(
  email: string | null | undefined,
  retryBaseMs: number = RETRY_BASE_MS,
): Promise<ContactSyncResult> {
  if (!isSignupContactSyncConfigured()) {
    return { ok: false, skipped: true, reason: 'not_configured' };
  }
  if (!email || !email.includes('@')) {
    return { ok: false, skipped: true, reason: 'invalid_email' };
  }

  const { kind, listIds } = planSignupContact(email, {
    signupsListId: config.MAILTRAP_SIGNUPS_LIST_ID,
    businessListId: config.MAILTRAP_BUSINESS_SIGNUPS_LIST_ID,
  });

  const url = `https://mailtrap.io/api/accounts/${config.MAILTRAP_ACCOUNT_ID}/contacts`;
  let lastStatus: number | undefined;
  let lastError = 'unknown error';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Api-Token': config.MAILTRAP_API_TOKEN as string,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ contact: { email, list_ids: listIds } }),
        signal: AbortSignal.timeout(10_000),
      });

      if (res.ok) return { ok: true, kind, alreadyExisted: false };

      const body = await res.text().catch(() => '');
      lastStatus = res.status;
      lastError = `Mailtrap ${res.status}: ${body}`;

      // Contact already registered (e.g. re-bootstrap race) — same outcome.
      if (res.status === 422 && /taken|exist/i.test(body)) {
        return { ok: true, kind, alreadyExisted: true };
      }
      // Other 4xx (bad token, bad list id) won't heal on retry.
      if (res.status < 500) break;
    } catch (err) {
      lastStatus = undefined;
      lastError = (err as Error).message;
    }

    if (attempt < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, attempt * retryBaseMs));
    }
  }

  console.warn(`[accounts/mailtrap-contacts] contact sync failed for signup: ${lastError}`);
  return { ok: false, status: lastStatus, error: lastError };
}
