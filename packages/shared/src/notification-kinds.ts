/**
 * The notification inbox contract (KRTX-1742), shared by the API, the web app
 * and the mobile app. `@kortix/sdk` is published and cannot import this
 * private package: it keeps its own copy, and a parity test in
 * `packages/sdk/src/core/rest/projects-client/notifications.test.ts` reads
 * this file.
 */

export const NOTIFICATION_KINDS = [
  'turn_done',
  'turn_error',
  'question',
  'permission',
  'shared',
  'automation_failed',
  'automation_recovered',
  'capture_device_down',
  'capture_device_recovered',
] as const;

export type NotificationKindName = (typeof NOTIFICATION_KINDS)[number];

export interface NotificationChannelPreference {
  push: boolean;
  email: boolean;
}

export type NotificationKindPreferences = Record<NotificationKindName, NotificationChannelPreference>;

/**
 * Defaults for a user with no saved record. The inbox row is always written;
 * these decide push (mobile + Web Push) and email.
 *
 * Email is opt-in for every kind that only the notification center ever
 * mailed: the center became every project's default, and a default-on email
 * would have mailed every member of every project at once (the 2026-10-09
 * incident). The two kinds left on were mailed before the center was on by
 * default: a trigger health or auto-pause alert (a delivery that is not one
 * lowers the default itself, `DeliverInput.emailDefault`) and a capture
 * computer that went down.
 */
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationKindPreferences = {
  turn_done: { push: true, email: false },
  turn_error: { push: true, email: false },
  question: { push: true, email: false },
  permission: { push: true, email: false },
  shared: { push: true, email: false },
  automation_failed: { push: true, email: true },
  automation_recovered: { push: true, email: false },
  capture_device_down: { push: true, email: true },
  capture_device_recovered: { push: true, email: false },
};

/** Kinds emailed as soon as they happen. Every other kind with email on joins the digest. */
export const IMMEDIATE_EMAIL_KINDS: readonly NotificationKindName[] = ['automation_failed', 'automation_recovered', 'capture_device_down', 'capture_device_recovered'];

/** Kinds never emailed in a digest: the ask goes stale before a digest is due. */
export const NEVER_DIGESTED_KINDS: readonly NotificationKindName[] = ['permission'];

/**
 * The push `type` installed mobile apps understand. Sessions kinds keep the
 * pre-KRTX-1742 names so an old app still routes a tap.
 */
export const LEGACY_PUSH_TYPE: Partial<Record<NotificationKindName, string>> = {
  turn_done: 'completion',
  turn_error: 'error',
  question: 'question',
  permission: 'permission',
};

export function pushTypeOf(kind: NotificationKindName): string {
  return LEGACY_PUSH_TYPE[kind] ?? kind;
}

/**
 * Hosts a Web Push endpoint may point at. The API posts to the endpoint a
 * browser registers, so any other host is refused (no SSRF through push).
 * A host matches when it equals a suffix or ends with `.<suffix>`.
 */
export const WEB_PUSH_HOST_SUFFIXES = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'push.services.mozilla.com',
  'web.push.apple.com',
  'notify.windows.com',
] as const;

export function isAllowedWebPushHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return WEB_PUSH_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export function isNotificationKind(value: unknown): value is NotificationKindName {
  return typeof value === 'string' && (NOTIFICATION_KINDS as readonly string[]).includes(value);
}

/** Per-kind defaults one delivery uses in place of `DEFAULT_NOTIFICATION_PREFERENCES`. */
export type NotificationDefaultsOverride = Partial<Record<NotificationKindName, Partial<NotificationChannelPreference>>>;

/**
 * Deep-merge a stored partial record over the defaults; unknown keys are
 * dropped. `defaults` replaces a kind's default for one delivery; a person's
 * saved choice still wins over it.
 */
export function effectiveNotificationPreferences(
  stored: unknown,
  defaults?: NotificationDefaultsOverride,
): NotificationKindPreferences {
  const out = {} as NotificationKindPreferences;
  const kinds = (stored && typeof stored === 'object' ? (stored as { kinds?: unknown }).kinds : undefined) as
    | Record<string, unknown>
    | undefined;
  for (const kind of NOTIFICATION_KINDS) {
    const base = { ...DEFAULT_NOTIFICATION_PREFERENCES[kind], ...defaults?.[kind] };
    const override = kinds && typeof kinds[kind] === 'object' && kinds[kind] !== null
      ? (kinds[kind] as Partial<NotificationChannelPreference>)
      : {};
    out[kind] = {
      push: typeof override.push === 'boolean' ? override.push : base.push,
      email: typeof override.email === 'boolean' ? override.email : base.email,
    };
  }
  return out;
}

/** The digest email delay: a row unread this long is listed in the next digest. */
export const NOTIFICATION_DIGEST_DELAY_MS = 15 * 60_000;
