import { db } from './db';
import { platformSettings, accessAllowlist } from '@kortix/db';
import { eq } from 'drizzle-orm';

const REFRESH_INTERVAL_MS = 60_000;

const globalForAccessControl = globalThis as typeof globalThis & {
  __kortixAccessControlRefreshTimer?: ReturnType<typeof setInterval> | null;
};

let signupsEnabled = true; // fail-open default
let allowedEmails = new Set<string>();
let allowedDomains = new Set<string>();
let refreshTimer: ReturnType<typeof setInterval> | null = null;

async function refresh() {
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

export function startAccessControlCache() {
  if (globalForAccessControl.__kortixAccessControlRefreshTimer) {
    clearInterval(globalForAccessControl.__kortixAccessControlRefreshTimer);
  }
  refresh(); // initial load (fire-and-forget)
  refreshTimer = setInterval(refresh, REFRESH_INTERVAL_MS);
  globalForAccessControl.__kortixAccessControlRefreshTimer = refreshTimer;
}

export function stopAccessControlCache() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (globalForAccessControl.__kortixAccessControlRefreshTimer) {
    clearInterval(globalForAccessControl.__kortixAccessControlRefreshTimer);
    globalForAccessControl.__kortixAccessControlRefreshTimer = null;
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
