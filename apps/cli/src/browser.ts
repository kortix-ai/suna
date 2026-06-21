import { spawn } from 'node:child_process';

function normalizeBrowserUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function openInBrowser(value: string): boolean {
  const url = normalizeBrowserUrl(value);
  if (!url) return false;

  const platform = process.platform;
  const command =
    platform === 'darwin'
      ? 'open'
      : platform === 'win32'
        ? 'rundll32.exe'
        : 'xdg-open';
  const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];

  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
