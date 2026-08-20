// Self-host email: set EMAIL_URL, get working email. Everything else derives.
//
// Before this, turning on email meant setting six SMTP_* variables AND
// remembering two more behavior flags (ENABLE_EMAIL_AUTOCONFIRM,
// KORTIX_PUBLIC_AUTH_METHODS) — and product email (invites) still did not work,
// because GoTrue's SMTP settings were never read by kortix-api. Now one
// connection string configures both halves:
//
//   kortix self-host env set EMAIL_URL=smtp://user:pass@smtp.example.com:587
//
// From that single value this module derives the GoTrue send-email hook (so
// auth mail is rendered and sent by kortix-api through the same provider),
// generates the shared HMAC secret, and — only on the transition into or out
// of "email configured" — flips the auth behavior flags so magic-link sign-in
// turns on with email and turns back off without it. Deriving only on the
// transition is what makes a later operator override stick: a steady-state
// rule would re-apply itself on every write and fight the operator forever.
import { randomBytes } from 'node:crypto';

/** Where GoTrue posts the send-email hook: the API, over the compose network. */
export const AUTH_EMAIL_HOOK_URI = 'http://kortix-api:8008/v1/webhooks/auth/send-email';

export interface EmailWiringOutcome {
  /** Keys this module changed, for restart-service accumulation. */
  changed: string[];
  /** Operator-facing lines describing what was derived. */
  notes: string[];
}

/** `v1,whsec_<base64>` — the secret format Supabase Auth hooks expect. */
export function generateAuthEmailHookSecret(): string {
  return `v1,whsec_${randomBytes(32).toString('base64')}`;
}

function isConfigured(value: string | undefined): boolean {
  return Boolean((value || '').trim());
}

/**
 * Reconcile every email-derived key against the current EMAIL_URL.
 *
 * `previousEmailUrl` is the value before this write. Pass the same value as
 * `env.EMAIL_URL` for an idempotent reconcile (no transition, no behavior
 * flags touched).
 */
export function applyEmailWiring(
  env: Record<string, string>,
  previousEmailUrl: string | undefined,
): EmailWiringOutcome {
  const changed: string[] = [];
  const notes: string[] = [];
  const set = (key: string, value: string) => {
    if (env[key] === value) return;
    env[key] = value;
    changed.push(key);
  };

  const nowConfigured = isConfigured(env.EMAIL_URL);
  const wasConfigured = isConfigured(previousEmailUrl);

  if (nowConfigured) {
    // The hook secret is generated once and then persists like every other
    // per-instance secret, so a restart does not invalidate GoTrue's copy.
    if (!isConfigured(env.AUTH_EMAIL_HOOK_SECRET)) {
      set('AUTH_EMAIL_HOOK_SECRET', generateAuthEmailHookSecret());
    }
    set('GOTRUE_HOOK_SEND_EMAIL_ENABLED', 'true');
    set('GOTRUE_HOOK_SEND_EMAIL_URI', AUTH_EMAIL_HOOK_URI);

    // A self-host that sends from noreply@kortix.com would fail SPF/DKIM at
    // every receiving server. Default the sender to the instance's own domain.
    if (!isConfigured(env.EMAIL_FROM)) {
      const domain = (env.KORTIX_DOMAIN || '').trim();
      if (domain) {
        set('EMAIL_FROM', `Kortix <noreply@${domain}>`);
        notes.push(`EMAIL_FROM defaulted to "Kortix <noreply@${domain}>"`);
      }
    }
  } else {
    set('GOTRUE_HOOK_SEND_EMAIL_ENABLED', 'false');
  }

  if (nowConfigured && !wasConfigured) {
    // Email now works, so stop auto-confirming signups and offer magic-link
    // sign-in. Both are the reason an operator configures email at all.
    set('ENABLE_EMAIL_AUTOCONFIRM', 'false');
    set('KORTIX_PUBLIC_AUTH_METHODS', 'password,magic');
    notes.push('email confirmation is now required (ENABLE_EMAIL_AUTOCONFIRM=false)');
    notes.push('magic-link sign-in enabled (KORTIX_PUBLIC_AUTH_METHODS=password,magic)');
  } else if (!nowConfigured && wasConfigured) {
    // Email is gone. Leaving confirmation required would lock every new signup
    // out of an instance that can no longer send the confirmation mail.
    set('ENABLE_EMAIL_AUTOCONFIRM', 'true');
    set('KORTIX_PUBLIC_AUTH_METHODS', 'password');
    notes.push('email removed — signups auto-confirm again and magic-link is off');
  }

  return { changed, notes };
}
