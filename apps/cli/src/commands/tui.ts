import { spawn } from 'node:child_process';

import { loadAuthForHost } from '../api/auth.ts';
import { takeFlagValue } from '../command-helpers.ts';
import { confirm } from '../prompts.ts';
import { C, help, status } from '../style.ts';
import {
  type TuiBinResolution,
  cliVersion,
  downloadTuiBin,
  findTuiBin,
  isValidTuiVersion,
  managedTuiPath,
  removeTuiCache,
  tuiCacheRoot,
} from '../tui-bin.ts';
import { isSupervised, SUPERVISED_NOTICE } from '../supervised.ts';

const DOCS_URL = 'https://kortix.com/docs/tui';

/**
 * The one line the launcher prints before the TUI takes the screen.
 *
 * It goes to STDERR on purpose. The TUI runs on the alternate screen; when it
 * exits, everything it painted is gone and only what was written before it
 * survives in scrollback. A user who never finds `?` still leaves with the two
 * facts that matter: the command is experimental, and where the docs are.
 */
export const EXPERIMENTAL_NOTICE = `kortix tui is experimental — keys: ? · docs: ${DOCS_URL}`;

const HELP = help`Usage: kortix tui [options]

Experimental. Open the Kortix terminal client: the sidebar of sessions, the
transcript and composer, a real shell inside the session sandbox, and the
Files, Review, Apps, Customize and Account screens — all in your terminal.

The TUI is a SEPARATE binary (\`kortix-tui\`, ~80 MB). \`kortix\` does not carry
it. The first \`kortix tui\` asks to install the copy that matches this CLI's
version into ~/.kortix/tui/<version>/, then runs it. Every later run execs the
cached one.

Authentication is this CLI's. It runs against the active host, or the one
\`--host\` names. With no host logged in, the TUI opens its own login screen
instead of failing.

Options:
  --host <name>     Use this configured host instead of the active one.
  --project <id>    List this project's sessions (default: the host's default
                    project, else its first project).
  --session <id>    Open this session at boot.
  --install         Install the TUI binary now and exit. No prompt.
  --uninstall       Remove ~/.kortix/tui/ and exit.
  -h, --help        Show this help.

Environment:
  KORTIX_TUI_BIN    Run this binary instead of a managed one — a local build
                    (pnpm --filter @kortix/tui bundle) or a packaged copy.
                    Nothing is downloaded and no version is checked.

Keys:
  ?                 Every binding, generated from the app's own keymap.
  Ctrl+p            Session switcher across every project.
  Ctrl+n            New session in this project.
  Alt+t             Toggle the sandbox terminal beside the transcript.
  Alt+f / Alt+r     Files · Review.
  Alt+a / Alt+c     Apps · Customize.
  Alt+u / Alt+h     Account · switch host.
  Alt+o             Hand this session to the stock opencode TUI.
  Ctrl+c twice      Quit.

Needs a real terminal at least 80x24 wide. Experimental means the screens,
keys and flags can change without a deprecation.

Examples:
  kortix tui
  kortix tui --install
  kortix tui --host cloud
  kortix tui --project <project-id> --session <session-id>

Docs: ${DOCS_URL}
`;

/** `v1.2.3` for a release, plain `dev` for a source build — never `vdev`. */
function label(version: string): string {
  return isValidTuiVersion(version) ? `v${version}` : version;
}

export interface TuiFlags {
  host?: string;
  project?: string;
  session?: string;
  install: boolean;
  uninstall: boolean;
  help: boolean;
}

/** `kortix tui` takes flags only — a bare positional is a typo, not an id. */
export function parseTuiFlags(argv: string[]): TuiFlags {
  const rest = [...argv];
  const flags: TuiFlags = { help: false, install: false, uninstall: false };
  for (let i = rest.length - 1; i >= 0; i -= 1) {
    const arg = rest[i];
    if (arg === '-h' || arg === '--help') {
      flags.help = true;
      rest.splice(i, 1);
    } else if (arg === '--install') {
      flags.install = true;
      rest.splice(i, 1);
    } else if (arg === '--uninstall') {
      flags.uninstall = true;
      rest.splice(i, 1);
    }
  }
  flags.host = takeFlagValue(rest, ['--host']);
  flags.project = takeFlagValue(rest, ['--project']);
  flags.session = takeFlagValue(rest, ['--session']);
  const left = rest[0];
  if (left !== undefined) {
    throw new Error(
      left.startsWith('-')
        ? `unknown option "${left}"`
        : `unexpected argument "${left}" — kortix tui takes options only (--project/--session)`,
    );
  }
  return flags;
}

/**
 * The boot environment the child TUI reads.
 *
 * The launcher does NOT resolve auth any more — `kortix-tui` reads the same
 * `~/.config/kortix/config.json` through the same `@kortix/cli` config module,
 * so resolving it twice could only introduce a disagreement. What the launcher
 * DOES own is the three things the flags say, and they travel as env because
 * the child is a standalone process whose only input is the environment
 * (apps/tui/src/index.tsx).
 */
export function tuiChildEnv(
  flags: Pick<TuiFlags, 'host' | 'project' | 'session'>,
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...base,
    ...(flags.host ? { KORTIX_TUI_HOST: flags.host } : {}),
    ...(flags.project ? { KORTIX_PROJECT_ID: flags.project } : {}),
    ...(flags.session ? { KORTIX_SESSION_ID: flags.session } : {}),
  };
}

export interface TuiDeps {
  /** `null` when the host has no usable token — `--host` then fails loudly. */
  loadAuthForHost: (name: string) => { token?: string } | null;
  /** Already-present binary, or null when one has to be downloaded. */
  findBin: () => TuiBinResolution | null;
  /** Fetches + checksum-verifies the release asset. Resolves to its path. */
  download: (version: string) => Promise<string>;
  /** Removes ~/.kortix/tui/. Resolves to the path it removed. */
  uninstall: () => string;
  /** This CLI's version — the TUI is matched to it exactly. */
  version: () => string;
  /** True only on a real terminal, where a question can be answered. */
  isInteractive: () => boolean;
  ask: (question: string, defaultValue: boolean) => Promise<boolean>;
  /** Runs the TUI and resolves its exit code. */
  run: (bin: string, env: NodeJS.ProcessEnv) => Promise<number>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const DEFAULT_DEPS: TuiDeps = {
  loadAuthForHost,
  findBin: () => findTuiBin(),
  download: (version) => downloadTuiBin({ version }),
  uninstall: () => removeTuiCache(),
  version: () => cliVersion(),
  isInteractive: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
  ask: (question, defaultValue) => confirm(question, defaultValue, { onEndOfInput: false }),
  run: spawnTui,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

/**
 * Hand the terminal to `kortix-tui` and resolve its exit code.
 *
 * `stdio: 'inherit'` is the whole point: the child owns the real tty — raw
 * mode, the alternate screen, the resize signals — exactly as if the user had
 * typed `kortix-tui`. A pipe here would break every one of those.
 */
function spawnTui(bin: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [], { stdio: 'inherit', env });
    // Ctrl+C reaches the whole foreground process group, so the launcher gets
    // the SIGINT too — and Node's default handler would kill it, returning the
    // shell prompt while the child still owns the alternate screen. The TUI
    // owns Ctrl+C (press twice); ignore the signals here and exit only when
    // the child does. The window matters: before the TUI turns raw mode on,
    // Ctrl+C really is a signal.
    const ignore = () => {};
    process.on('SIGINT', ignore);
    process.on('SIGTERM', ignore);
    const done = (value: number | Error) => {
      process.off('SIGINT', ignore);
      process.off('SIGTERM', ignore);
      if (value instanceof Error) reject(value);
      else resolve(value);
    };
    child.on('error', done);
    // A signal death has no exit code. Report it the way a shell does
    // (128 + signo) so `kortix tui` and a bare `kortix-tui` agree.
    child.on('exit', (code, signal) => done(code ?? (signal ? 128 + (SIGNALS[signal] ?? 0) : 1)));
  });
}

const SIGNALS: Record<string, number> = { SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };

export async function runTui(argv: string[], overrides: Partial<TuiDeps> = {}): Promise<number> {
  const deps: TuiDeps = { ...DEFAULT_DEPS, ...overrides };

  let flags: TuiFlags;
  try {
    flags = parseTuiFlags(argv);
  } catch (err) {
    deps.stderr(`${(err as Error).message}\n\n${HELP}`);
    return 2;
  }
  if (flags.help) {
    deps.stdout(HELP);
    return 0;
  }

  if (flags.uninstall) {
    const removed = deps.uninstall();
    deps.stdout(`${status.ok(`removed ${removed}`)}\n`);
    return 0;
  }

  if (flags.host) {
    // An explicit `--host` is a claim about WHICH instance. A missing or
    // token-less one is an error, not an invitation to log into another. The
    // check lives here rather than in the TUI so the message is the CLI's.
    const auth = deps.loadAuthForHost(flags.host);
    if (!auth?.token) {
      deps.stderr(
        `${status.err(`Host "${flags.host}" is not logged in.`)} Run ` +
          `${C.cyan}kortix hosts login ${flags.host}${C.reset}.\n`,
      );
      return 1;
    }
  }

  const version = deps.version();
  let resolution = deps.findBin();

  // `--install` is the non-interactive front door: it installs (or reports
  // what is already there) and never takes the terminal.
  if (flags.install) {
    if (resolution) {
      deps.stdout(
        `${status.ok(`kortix-tui ${label(version)} is already installed`)}  ${C.dim}${resolution.bin}${C.reset}\n`,
      );
      return 0;
    }
    const installed = await install(version, true, deps);
    if (typeof installed === 'number') return installed;
    deps.stdout(
      `${status.ok(`installed kortix-tui ${label(version)}`)}  ${C.dim}${installed}${C.reset}\n`,
    );
    return 0;
  }

  if (!resolution) {
    const installed = await install(version, false, deps);
    if (typeof installed === 'number') return installed;
    resolution = { bin: installed, source: 'downloaded' };
  }

  deps.stderr(`${EXPERIMENTAL_NOTICE}\n`);
  return deps.run(resolution.bin, tuiChildEnv(flags, process.env));
}

/**
 * Get a binary on disk, or return the exit code that explains why we can't.
 *
 * Three ways this ends without a download:
 *   - a source build (`dev`) has no published release to match — the remedy is
 *     to build one, and saying so beats inventing a URL for a version that was
 *     never released;
 *   - nobody is at the keyboard (a script, CI, a pipe) — an 80 MB download is
 *     not something to start on someone's behalf with no way to say no;
 *   - the user says no.
 */
async function install(
  version: string,
  skipPrompt: boolean,
  deps: TuiDeps,
): Promise<string | number> {
  // Refuse BEFORE the prompt, not at the download. The question below defaults
  // to yes and the Session terminal is a real PTY, so asking it inside a
  // managed box is the same trap the update prompt was: one Enter and an 80 MB
  // binary nobody converges lands in ~/.kortix/tui. The TUI is a client for a
  // developer's own machine; a managed box has no managed copy of it.
  if (isSupervised()) {
    deps.stderr(
      `${status.err('kortix tui cannot install itself in this sandbox.')}\n` +
        `  ${C.dim}${SUPERVISED_NOTICE}${C.reset}\n` +
        `  ${C.dim}Run ${C.reset}${C.cyan}kortix tui${C.reset}${C.dim} on your own machine, or set KORTIX_TUI_BIN.${C.reset}\n`,
    );
    return 1;
  }

  if (!isValidTuiVersion(version)) {
    // The `dev` case: a local `bun run src/index.ts` or an unversioned build.
    deps.stderr(
      `${status.err('No kortix-tui binary for this build.')}\n` +
        `  ${C.dim}This \`kortix\` reports version "${version}", which has no published release.${C.reset}\n` +
        `  Build one:  ${C.cyan}pnpm --filter @kortix/tui bundle${C.reset}\n` +
        `  Then:       ${C.cyan}KORTIX_TUI_BIN=<path to the built kortix-tui> kortix tui${C.reset}\n` +
        `  ${C.dim}Or copy it to ${managedTuiPath(version)} and run \`kortix tui\` as usual.${C.reset}\n`,
    );
    return 1;
  }

  if (!skipPrompt) {
    if (!deps.isInteractive()) {
      deps.stderr(
        `${status.err('kortix tui needs the kortix-tui binary, which is not installed.')}\n` +
          `  Run:  ${C.cyan}kortix tui --install${C.reset}\n`,
      );
      return 2;
    }
    const yes = await deps.ask(
      `kortix tui is experimental and installs separately (~80 MB, ${tuiCacheRoot()}/${version}/). Install now?`,
      true,
    );
    if (!yes) {
      deps.stdout(
        `${C.dim}Not installed. Run \`kortix tui --install\` when you want it.${C.reset}\n`,
      );
      return 0;
    }
  }

  try {
    return await deps.download(version);
  } catch (err) {
    deps.stderr(
      `${status.err(`Could not install kortix-tui ${label(version)}: ${(err as Error).message}`)}\n` +
        `  ${C.dim}Build one yourself (pnpm --filter @kortix/tui bundle) and set KORTIX_TUI_BIN.${C.reset}\n`,
    );
    return 1;
  }
}
