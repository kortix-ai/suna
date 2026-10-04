import { db } from '../../lib/db';
import { platformSettings, accessAllowlist } from '@kortix/db';
import { eq } from 'drizzle-orm';

let signupsEnabled = true; // fail-open default
let allowedEmails = new Set<string>();
let allowedDomains = new Set<string>();

/** One refresh of the signup setting and the allowlist. Never throws: a failure keeps the previous state. */
export async function refreshAccessControlCache() {
  try {
    // Load signups_enabled setting
    const [setting] = await db
      .select()
      .from(platformSettings)
      .where(eq(platformSettings.key, 'signups_enabled'));

    signupsEnabled = setting ? setting.value === true || setting.value === 'true' : true;

    // Load allowlist entries
    const entries = await db.select().from(accessAllowlist);
    const emails = new Set<string>();
    const domains = new Set<string>();
    for (const entry of entries) {
      if (entry.entryType === 'email') emails.add(entry.value.toLowerCase());
      else if (entry.entryType === 'domain') domains.add(entry.value.toLowerCase());
    }
    allowedEmails = emails;
    allowedDomains = domains;
  } catch (err) {
    // Fail open — keep previous state (defaults to signups enabled)
    console.error('[access-control-cache] refresh failed, keeping previous state:', err);
  }
}

export function areSignupsEnabled(): boolean {
  return signupsEnabled;
}

function isEmailAllowed(email: string): boolean {
  const lower = email.toLowerCase();
  if (allowedEmails.has(lower)) return true;
  const domain = lower.split('@')[1];
  if (domain && allowedDomains.has(domain)) return true;
  return false;
}

export function canSignUp(email: string): boolean {
  if (signupsEnabled) return true;
  return isEmailAllowed(email);
}
