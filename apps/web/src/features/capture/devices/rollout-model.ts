/**
 * IT rollout rules the Devices page shows: no React, unit-tested.
 */

/** Email domains typed as a list (commas, spaces or new lines); `@corp.example` and `corp.example` are one. */
export function parseDomains(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,;]+/)
        .map((part) => part.trim().toLowerCase().replace(/^@/, ''))
        .filter(Boolean),
    ),
  ];
}

/** The Kortix URL a computer enrolls with: the API origin without `/v1` (the engine adds it). */
export function enrollmentUrl(backendUrl: string | undefined): string {
  return (backendUrl || 'https://api.kortix.com/v1').replace(/\/+$/, '').replace(/\/v1$/, '');
}

/** The silent install IT runs on every Windows computer. */
export function msiCommand(url: string, token: string): string {
  return `msiexec /i KortixCapture.msi /qn KORTIX_URL=${url} ENROLLMENT_TOKEN=${token}`;
}

/** The token's lifetime choices, in days; null never expires. */
export const EXPIRY_DAYS = [7, 30, 90, null] as const;
export type ExpiryDays = (typeof EXPIRY_DAYS)[number];

/** A computer limit typed as text: a whole number from 1, else no limit (null). */
export function parseLimit(text: string): number | null {
  const value = Number(text.trim());
  return text.trim() && Number.isInteger(value) && value >= 1 ? value : null;
}

/** The Windows person a waiting computer named: the UPN, else the login name. */
export function personLabel(enrollment: { principal_name: string | null; account_name: string | null }): string {
  return enrollment.principal_name || enrollment.account_name || '';
}
