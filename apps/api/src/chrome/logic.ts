/**
 * Kortix for Chrome: the pure rules. No database, no sockets.
 * Protocol: .agents/skills/kortix-chrome/references/protocol.md
 */

/** A browser is online when its last ping is newer than this. */
export const ONLINE_WINDOW_MS = 75_000;
/**
 * How long an attach waits for the person to answer in Chrome. The protocol
 * says 120 s; Cloudflare cuts a request at 100 s with a 524, so the API answers
 * 408 first, at 90 s.
 */
export const CONSENT_TIMEOUT_MS = 90_000;
export const CONSENT_POLL_MS = 300;

export type AccessMode = 'always' | 'ask' | 'off';
export type TabScope = 'own' | 'all';

export interface ChromeRow {
  chromeId: string;
  name: string;
  brand: string;
  os: string;
  profileLabel: string | null;
  extensionVersion: string | null;
  accessMode: string;
  tabScope: string;
  lastSeenAt: Date | null;
  /** The API replica holding the control socket; null once it closed. */
  relayOwnerId: string | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface ActiveSession {
  sessionId: string;
  projectId: string;
  title: string;
}

/** The `Browser` object of the protocol. */
export interface ChromeDto {
  id: string;
  name: string;
  brand: string;
  os: string;
  profileLabel: string | null;
  extensionVersion: string | null;
  accessMode: AccessMode;
  tabScope: TabScope;
  online: boolean;
  lastSeenAt: string | null;
  createdAt: string;
  activeSessions: ActiveSession[];
}

/** Online: a replica holds its control socket (relayOwnerId) and it pinged within the window. */
export function isOnline(row: Pick<ChromeRow, 'lastSeenAt' | 'revokedAt' | 'relayOwnerId'>, now = Date.now()): boolean {
  return (
    row.revokedAt === null &&
    row.relayOwnerId !== null &&
    row.lastSeenAt !== null &&
    now - row.lastSeenAt.getTime() < ONLINE_WINDOW_MS
  );
}

export function toChromeDto(row: ChromeRow, activeSessions: ActiveSession[] = [], now = Date.now()): ChromeDto {
  return {
    id: row.chromeId,
    name: row.name,
    brand: row.brand,
    os: row.os,
    profileLabel: row.profileLabel,
    extensionVersion: row.extensionVersion,
    accessMode: row.accessMode as AccessMode,
    tabScope: row.tabScope as TabScope,
    online: isOnline(row, now),
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    activeSessions,
  };
}

// ── Errors ──────────────────────────────────────────────────────────────────

export type ChromeErrorCode =
  | 'chrome_not_connected'
  | 'chrome_not_found'
  | 'chrome_offline'
  | 'chrome_access_off'
  | 'chrome_denied'
  | 'chrome_consent_timeout'
  | 'chrome_panel_forbidden'
  | 'chrome_panel_no_email';

const ERRORS: Record<ChromeErrorCode, { status: 403 | 404 | 408 | 409; error: string }> = {
  chrome_not_connected: {
    status: 404,
    error: 'No browser is connected to Kortix.',
  },
  chrome_not_found: {
    status: 404,
    error: 'No connected browser matches that name or id. Run `kortix chrome ls` to see the connected browsers.',
  },
  chrome_offline: {
    status: 409,
    error: 'The browser is not online: Chrome is closed, or the Kortix extension is signed out.',
  },
  chrome_access_off: {
    status: 403,
    error: 'The user turned off agent access for this browser. Ask the user to turn it on in Settings → Chrome extension.',
  },
  chrome_denied: {
    status: 403,
    error: 'The user stopped or denied this session\'s access to the browser. Ask the user before you try again.',
  },
  chrome_consent_timeout: {
    status: 408,
    error: 'Nobody answered the prompt in Chrome within 90 seconds. Ask the user to approve it, then retry.',
  },
  chrome_panel_forbidden: {
    status: 403,
    error: 'Only the Kortix in Chrome extension can open a side panel session.',
  },
  chrome_panel_no_email: {
    status: 409,
    error: 'This account has no email address, so the side panel cannot sign in.',
  },
};

export class ChromeError extends Error {
  readonly status: 403 | 404 | 408 | 409;
  constructor(readonly code: ChromeErrorCode) {
    super(ERRORS[code].error);
    this.status = ERRORS[code].status;
  }
}

/** The error body of every browser route. */
export function chromeErrorBody(code: ChromeErrorCode, frontendUrl: string) {
  return { error: ERRORS[code].error, code, connectUrl: `${frontendUrl.replace(/\/+$/, '')}/settings/chrome` };
}

// ── Picking a browser ───────────────────────────────────────────────────────

/**
 * Choose the browser an attach uses. With `wanted` set: match id or name
 * (case-insensitive) among the non-revoked rows. Without it: the online row
 * with the newest `lastSeenAt`.
 */
export function pickChrome<T extends ChromeRow>(rows: T[], wanted: string | undefined, now = Date.now()): T {
  const live = rows.filter((r) => r.revokedAt === null);
  if (live.length === 0) throw new ChromeError('chrome_not_connected');
  const name = wanted?.trim().toLowerCase();
  if (name) {
    const hit = live.find((r) => r.chromeId.toLowerCase() === name || r.name.toLowerCase() === name);
    if (!hit) throw new ChromeError('chrome_not_found');
    if (!isOnline(hit, now)) throw new ChromeError('chrome_offline');
    return hit;
  }
  const online = live
    .filter((r) => isOnline(r, now))
    .sort((a, b) => b.lastSeenAt!.getTime() - a.lastSeenAt!.getTime());
  if (online.length === 0) throw new ChromeError('chrome_offline');
  return online[0];
}

// ── Consent ─────────────────────────────────────────────────────────────────

export interface GrantRow {
  projectId: string;
  sessionId: string | null;
  decision: string;
}

export type ConsentOutcome = 'granted' | 'ask';

/**
 * Decide whether an attach needs a prompt in Chrome.
 * Throws `chrome_access_off` or `chrome_denied`. `ask=true` always shows a
 * prompt, and it overrides an earlier deny for this session.
 */
export function decideConsent(input: {
  accessMode: string;
  grants: GrantRow[];
  sessionId: string;
  projectId: string;
  ask: boolean;
}): ConsentOutcome {
  if (input.accessMode === 'off') throw new ChromeError('chrome_access_off');
  if (input.ask) return 'ask';
  if (input.grants.some((g) => g.sessionId === input.sessionId && g.decision === 'deny')) {
    throw new ChromeError('chrome_denied');
  }
  if (input.accessMode === 'always') return 'granted';
  const allowed = input.grants.some(
    (g) =>
      g.decision === 'allow' &&
      (g.sessionId === input.sessionId || (g.sessionId === null && g.projectId === input.projectId)),
  );
  return allowed ? 'granted' : 'ask';
}

export type ConsentDecision = 'session' | 'project' | 'deny';

export function isConsentDecision(v: unknown): v is ConsentDecision {
  return v === 'session' || v === 'project' || v === 'deny';
}

/** A detach reason that means the person pressed Stop. */
export function isStopReason(reason: unknown): boolean {
  return reason === 'stopped' || reason === 'canceled_by_user';
}
