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
  return `msiexec /i KortixCapture-x64.msi /qn KORTIX_URL=${url} ENROLLMENT_TOKEN=${token}`;
}

export type RolloutOs = 'windows' | 'macos' | 'linux';
export const ROLLOUT_OS: readonly RolloutOs[] = ['windows', 'macos', 'linux'];

/** The machine config IT writes on macOS and Linux (root-only, 0600): the engine's `config.json`. */
const configJson = (url: string, token: string) => JSON.stringify({ url, enrollment_token: token });

/** The install IT runs on one computer of `os`, enrollment token included. */
export function installCommand(os: RolloutOs, url: string, token: string): string {
  if (os === 'windows') return msiCommand(url, token);
  if (os === 'macos') {
    const dir = '/Library/Application Support/Kortix/Capture';
    return [
      `sudo mkdir -p "${dir}"`,
      `echo '${configJson(url, token)}' | sudo tee "${dir}/config.json" >/dev/null`,
      `sudo chmod 600 "${dir}/config.json"`,
      'sudo installer -pkg KortixCapture-universal.pkg -target /',
    ].join('\n');
  }
  return [
    'sudo install -d -m 755 /etc/kortix',
    `echo '${configJson(url, token)}' | sudo tee /etc/kortix/capture.json >/dev/null`,
    'sudo chmod 600 /etc/kortix/capture.json',
    'sudo apt install ./kortix-capture_amd64.deb',
  ].join('\n');
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

/** A token's expiry as a calendar date (`12 Nov 2026`): a future instant, which `relativeTime` does not format. */
export function expiryDate(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
