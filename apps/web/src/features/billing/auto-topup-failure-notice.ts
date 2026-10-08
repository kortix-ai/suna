import type { AutoTopupSettings } from '@kortix/sdk';

/**
 * The notice for a failed auto top-up charge (KRTX-1718): it turned auto
 * top-up off, or it is still on and retrying. A failure on an auto top-up
 * that was then turned off by hand shows nothing: nothing retries.
 */
export function autoTopupFailureNotice(
  settings: AutoTopupSettings | undefined,
  locale: string,
): { key: 'turnedOffAfterFailure' | 'lastChargeFailed'; values: { date: string; reason: string } } | null {
  const reason = settings?.disabled_reason ?? (settings?.enabled ? settings.last_failure_reason : null);
  if (!reason || !settings?.last_failure_at) return null;
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(settings.last_failure_at),
  );
  return { key: settings.disabled_reason ? 'turnedOffAfterFailure' : 'lastChargeFailed', values: { date, reason } };
}
