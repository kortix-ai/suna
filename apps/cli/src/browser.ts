import { spawn } from 'node:child_process';

interface BrowserProcess {
  once(event: 'error', listener: (error: Error) => void): BrowserProcess;
  unref(): void;
}

type BrowserSpawner = (
  command: string,
  args: string[],
  options: { stdio: 'ignore'; detached: true },
) => BrowserProcess;

interface BrowserOpenOptions {
  platform?: NodeJS.Platform;
  spawn?: BrowserSpawner;
  env?: NodeJS.ProcessEnv;
}

function normalizeBrowserUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function openInBrowser(value: string, options: BrowserOpenOptions = {}): boolean {
  // CI callers must handle the printed URL themselves. This also prevents
  // black-box CLI tests from opening the host machine's default browser.
  if ((options.env ?? process.env).CI) return false;

  const url = normalizeBrowserUrl(value);
  if (!url) return false;

  const platform = options.platform ?? process.platform;
  const command =
    platform === 'darwin'
      ? 'open'
      : platform === 'win32'
        ? 'rundll32.exe'
        : 'xdg-open';
  const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];

  try {
    const spawnBrowser = options.spawn ?? (spawn as BrowserSpawner);
    const child = spawnBrowser(command, args, { stdio: 'ignore', detached: true });
    // Node reports a missing `open`/`xdg-open` executable asynchronously.
    // Without this listener, headless Linux processes exit on an uncaught
    // ChildProcess error before the caller can continue its non-browser flow.
    child.once('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
