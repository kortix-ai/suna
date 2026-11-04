/**
 * App → agent: an App POSTs named events, and every `type: app` trigger that
 * names the App starts or continues a session (../projects/lib/app-events.ts).
 *
 * The App proves who it is with `KORTIX_APP_TOKEN`, an HMAC of its id under
 * the platform secret, derived like `appViewerSecret` (./viewer.ts): nothing
 * is stored, and a leaked token emits events for that one App and nothing
 * else. Rotating the platform secret rotates every App's token.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { oauthIssuer } from '../oauth/discovery';
import { appAccessSecret } from './access';

// ponytail: one token per App with no revocation list; rotate by bumping `v1` or the platform secret.
export function appEventToken(appId: string): string {
  return createHmac('sha256', appAccessSecret()).update('kortix-app-events:v1\0').update(appId).digest('hex');
}

export function appEventTokenMatches(appId: string, presented: string): boolean {
  const expected = Buffer.from(appEventToken(appId));
  const actual = Buffer.from(presented);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function appEventsUrl(app: { appId: string; projectId: string }): string {
  return `${oauthIssuer()}/v1/projects/${app.projectId}/apps/${app.appId}/events`;
}

/** What every App machine gets to emit events: where to POST, and the token. */
export function appEventEnv(app: { appId: string; projectId: string }): Record<string, string> {
  return { KORTIX_APP_ID: app.appId, KORTIX_APP_EVENTS_URL: appEventsUrl(app), KORTIX_APP_TOKEN: appEventToken(app.appId) };
}

const DURATION = /^(\d+)(s|m|h|d)?$/;
const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400 } as const;

/** `30s`, `10m`, `2h`, `7d`, or a number of seconds → seconds; NaN when malformed. */
export function scheduleDelaySeconds(value: string | number): number {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : Number.NaN;
  const match = DURATION.exec(value.trim());
  return match ? Number(match[1]) * UNIT_SECONDS[(match[2] ?? 's') as keyof typeof UNIT_SECONDS] : Number.NaN;
}
