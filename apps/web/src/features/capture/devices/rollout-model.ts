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

/** The silent install from an MSI next to the command (Intune, Group Policy, a script). */
export function msiCommand(url: string, token: string): string {
  return `msiexec /i KortixCapture-x64.msi /qn KORTIX_URL=${url} ENROLLMENT_TOKEN=${token}`;
}

/** Where a computer downloads an installer: the dev build for the dev API, else the latest release. */
export function installerUrl(url: string, file: string): string {
  const tag = /\/\/dev-api\./.test(url) ? 'download/capture-dev-latest' : 'latest/download';
  return `https://github.com/kortix-ai/suna/releases/${tag}/${file}`;
}

/** The Windows installer's download address. */
export const windowsInstallerUrl = (url: string) => installerUrl(url, 'KortixCapture-x64.msi');

/**
 * One Command Prompt line (as administrator) that downloads the installer, installs it
 * silently and waits (`start /wait`: msiexec alone returns at once), then says whether it
 * worked and where the log is. `curl.exe` ships with Windows 10 1803 and later.
 */
export function windowsCmd(url: string, token: string): string {
  const msi = '"%TEMP%\\KortixCapture-x64.msi"';
  const log = '"%TEMP%\\KortixCapture-install.log"';
  return (
    [
      `curl.exe -fsSL -o ${msi} ${windowsInstallerUrl(url)}`,
      `start /wait msiexec /i ${msi} /qn /l*v ${log} KORTIX_URL=${url} ENROLLMENT_TOKEN=${token}`,
      // A rolled-back install can still exit 0 here: the service must exist.
      'sc query KortixCapture >nul 2>&1',
      'echo Kortix Capture installed. It records from the next Windows sign-in.',
    ].join(' && ') + ` || echo Install failed. Log: ${log}`
  );
}

export type RolloutOs = 'windows' | 'macos' | 'linux';
export const ROLLOUT_OS: readonly RolloutOs[] = ['windows', 'macos', 'linux'];

/** The machine config IT writes on macOS and Linux (root-only, 0600): the engine's `config.json`. */
const configJson = (url: string, token: string) => JSON.stringify({ url, enrollment_token: token });

/** The install IT runs on one computer of `os`, enrollment token included. */
export function installCommand(os: RolloutOs, url: string, token: string): string {
  if (os === 'windows') return windowsCmd(url, token);
  if (os === 'macos') {
    const dir = '/Library/Application Support/Kortix/Capture';
    return [
      `sudo mkdir -p "${dir}"`,
      `echo '${configJson(url, token)}' | sudo tee "${dir}/config.json" >/dev/null`,
      `sudo chmod 600 "${dir}/config.json"`,
      `curl -fsSL -o /tmp/KortixCapture-universal.pkg ${installerUrl(url, 'KortixCapture-universal.pkg')} && sudo installer -pkg /tmp/KortixCapture-universal.pkg -target / && echo "Kortix Capture installed."`,
    ].join('\n');
  }
  return [
    'sudo install -d -m 755 /etc/kortix',
    `echo '${configJson(url, token)}' | sudo tee /etc/kortix/capture.json >/dev/null`,
    'sudo chmod 600 /etc/kortix/capture.json',
    `curl -fsSL -o /tmp/kortix-capture_amd64.deb ${installerUrl(url, 'kortix-capture_amd64.deb')} && sudo apt-get install -y /tmp/kortix-capture_amd64.deb && echo "Kortix Capture installed."`,
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
export function personLabel(enrollment: {
  principal_name: string | null;
  account_name: string | null;
}): string {
  return enrollment.principal_name || enrollment.account_name || '';
}

/** A token's expiry as a calendar date (`12 Nov 2026`): a future instant, which `relativeTime` does not format. */
export function expiryDate(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
