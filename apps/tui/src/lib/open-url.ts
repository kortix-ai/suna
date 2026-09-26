/**
 * Hand a URL to the desktop's browser.
 *
 * The Apps screen prints a deployed App's URL, and `o` opens it. A terminal
 * cannot render the page, so the only useful action is to pass the URL to
 * whatever the desktop uses — `open` on macOS, `xdg-open` on Linux/BSD,
 * `cmd /c start` on Windows.
 *
 * Two rules make that safe, because the URL is server data, not a literal:
 *
 * 1. **Scheme allowlist.** Only `http:` and `https:` are handed out. `open`
 *    on macOS launches the handler for ANY scheme, so a row carrying
 *    `file:///…`, `javascript:…` or a registered custom scheme would run
 *    something the user never asked for. An App URL is always https; anything
 *    else is rejected with the scheme named.
 * 2. **No shell.** The command is an argv array executed directly, never a
 *    string passed to a shell, so a URL cannot inject a command. A URL that
 *    starts with `-` is still rejected: `open` would read it as a flag.
 *
 * The spawner is injectable so the unit test asserts the exact argv without
 * launching a browser.
 */

/** Runs one argv. Resolves when the child has been launched, not when it exits. */
export type UrlSpawner = (argv: string[]) => void | Promise<void>;

export interface OpenUrlOptions {
  /** `process.platform`. A parameter so one test covers all three branches. */
  platform?: NodeJS.Platform | string;
  /** Defaults to `Bun.spawn` with stdio detached from this terminal. */
  spawn?: UrlSpawner;
}

/** The argv `platform` uses to open a URL. */
export function openCommand(url: string, platform: NodeJS.Platform | string): string[] {
  if (platform === 'darwin') return ['open', url];
  if (platform === 'win32') return ['cmd', '/c', 'start', '', url];
  return ['xdg-open', url];
}

/**
 * Throw unless `url` is an absolute http(s) URL.
 *
 * Returns the parsed URL so a caller that needs the host does not re-parse.
 */
export function assertOpenableUrl(url: string): URL {
  const trimmed = url.trim();
  if (!trimmed) throw new Error('No URL on this row.');
  if (trimmed.startsWith('-')) throw new Error(`Refusing to open ${trimmed}: reads as a flag.`);
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Not a URL: ${trimmed}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Refusing to open a ${parsed.protocol} URL.`);
  }
  return parsed;
}

/**
 * The default spawner: launch the opener detached from this terminal.
 *
 * `stdout`/`stderr` are ignored on purpose. `xdg-open` and some handlers print
 * to the inherited descriptors, and a stray line written into the alternate
 * screen corrupts the frame OpenTUI believes it drew.
 */
const bunSpawn: UrlSpawner = (argv) => {
  const runtime = (globalThis as { Bun?: { spawn: (argv: string[], options: object) => unknown } })
    .Bun;
  if (!runtime) throw new Error('openUrl needs Bun.spawn');
  runtime.spawn(argv, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
};

/**
 * Open `url` in the desktop browser.
 *
 * Throws with a one-line reason the caller can toast verbatim: a rejected
 * scheme, or the spawn failure (`xdg-open` missing on a headless box).
 */
export async function openUrl(url: string, options: OpenUrlOptions = {}): Promise<string[]> {
  const parsed = assertOpenableUrl(url);
  const platform = options.platform ?? process.platform;
  const argv = openCommand(parsed.toString(), platform);
  const spawn = options.spawn ?? bunSpawn;
  try {
    await spawn(argv);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${argv[0]} failed: ${reason}`);
  }
  return argv;
}
