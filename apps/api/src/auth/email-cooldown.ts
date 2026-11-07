import { sql } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../shared/db';

/**
 * One auth email per address per minute, whatever the client does.
 *
 * GoTrue mails a signup confirmation on every `signUp` and every `/otp` for an
 * unconfirmed address, and a magic link on every `/otp` for a confirmed one.
 * Its own per-user interval (`SMTP_MAX_FREQUENCY`, "minimum interval per user")
 * is a project setting; when it is low, a visitor who does not see the email
 * at once clicks again and the address gets one email per click (a prod
 * address got 61 confirmation emails in 14 minutes). The sender timestamps
 * GoTrue writes on `auth.users` are the shared state that holds across API
 * replicas, browser tabs and reloads, so the cooldown reads them.
 */
export const AUTH_EMAIL_COOLDOWN_SECONDS = 60;

export interface AuthEmailState {
  /** The address has a row in `auth.users`. */
  exists: boolean;
  /** Seconds until GoTrue may mail this address again, or null when it may now. */
  retryAfterSeconds: number | null;
}

/** Seconds left in the cooldown, from the age of the newest auth email. */
export function retryAfterFromAge(ageSeconds: unknown): number | null {
  const age = typeof ageSeconds === 'number' ? ageSeconds : Number(ageSeconds);
  if (ageSeconds === null || ageSeconds === undefined || !Number.isFinite(age)) return null;
  const left = Math.ceil(AUTH_EMAIL_COOLDOWN_SECONDS - Math.max(0, age));
  return left > 0 ? left : null;
}

/**
 * Whether the address has an account, and how long until it may get another
 * auth email. The age comes from the database clock, the same clock that wrote
 * the timestamps. A lookup failure fails open (no account, no cooldown): an
 * unreachable database must not lock every visitor out of sign-in.
 */
export async function authEmailState(email: string): Promise<AuthEmailState> {
  if (!config.DATABASE_URL) return { exists: false, retryAfterSeconds: null };
  try {
    const result = await db.execute(sql`
      SELECT 1 AS found,
        EXTRACT(EPOCH FROM (now() - GREATEST(confirmation_sent_at, recovery_sent_at)))::float8 AS email_age_seconds
      FROM auth.users
      WHERE email = ${email.trim().toLowerCase()}
      LIMIT 1
    `);
    const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
    const row = rows[0] as { email_age_seconds?: unknown } | undefined;
    if (!row) return { exists: false, retryAfterSeconds: null };
    return { exists: true, retryAfterSeconds: retryAfterFromAge(row.email_age_seconds) };
  } catch {
    return { exists: false, retryAfterSeconds: null };
  }
}
