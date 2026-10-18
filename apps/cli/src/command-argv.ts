/**
 * The argument grammar every `kortix <command>` shares: when help prints, and
 * how a command whose argv holds only flags rejects an argument it does not
 * know. Flag values come from takeFlagValue / takeFlagBool in
 * command-helpers.ts, which accept both `--flag value` and `--flag=value`.
 *
 * TODO(#7113): fold into command-helpers.ts once #7113 no longer holds it.
 */

const isHelpArg = (arg: string) => arg === '-h' || arg === '--help';

/**
 * The per-invocation flags that may lead the line (KRTX-2603): the same
 * `--host` / `--project` every command documents under its own Global
 * options. `liftLeadingGlobalFlags` moves them after the command token, so
 * `kortix --host <name> sessions ls` reaches `sessions` instead of reporting
 * `unknown command "--host"`. Anything else flag-shaped in command position
 * stays untouched for the caller to name in its error.
 */
const LEADING_GLOBAL_FLAGS = new Set(['--host', '--project']);

export function liftLeadingGlobalFlags(argv: readonly string[]): string[] {
  const lifted: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (!arg.startsWith('--')) break;
    const eq = arg.indexOf('=');
    const name = eq < 0 ? arg : arg.slice(0, eq);
    if (!LEADING_GLOBAL_FLAGS.has(name)) break;
    if (eq < 0) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) break;
      lifted.push(name, value);
      i += 2;
    } else {
      lifted.push(arg);
      i += 1;
    }
  }
  const command = argv[i];
  // No documented flag led the line, or only flags follow: leave argv alone —
  // a help flag in command position is the root help, an unknown flag is the
  // caller's option error.
  if (lifted.length === 0 || command === undefined || command.startsWith('-')) {
    return [...argv];
  }
  return [command, ...argv.slice(i + 1), ...lifted];
}

/**
 * Help for a command with subcommands (`kortix <cmd> <subcommand> …`). The
 * root help promises `kortix <cmd> <subcommand> --help`, so `-h` / `--help`
 * anywhere in argv prints `help` to stdout and returns 0. A bare `kortix <cmd>`
 * prints it and returns 2. Returns null when argv asks for no help.
 */
export function splitHelp(argv: readonly string[], help: string): number | null {
  if (argv.length > 0 && !argv.some(isHelpArg)) return null;
  process.stdout.write(help);
  return argv.length === 0 ? 2 : 0;
}

/** Prints an argument error for a command and returns its exit code. */
export type ReportArgError = (message: string, usage: string) => number;

/** The flag-only commands' argument error: the message, a blank line and the usage on stderr; exit 2. */
export const usageError: ReportArgError = (message, usage) => {
  process.stderr.write(`${message}\n\n${usage}`);
  return 2;
};

/**
 * The leftovers check of a flag-only command: `rest` is argv after every known
 * flag was taken out. Anything left reports `unknown option "<first>"` and
 * returns the report's exit code. Returns null when nothing is left.
 */
export function rejectUnknownArgs(
  rest: readonly string[],
  usage: string,
  report: ReportArgError = usageError,
): number | null {
  return rest.length === 0 ? null : report(`unknown option "${rest[0]}"`, usage);
}

/**
 * Parse a flag-only command (`kortix whoami`, `kortix login`, …). `take` pulls
 * every known flag out of a copy of argv with takeFlagValue / takeFlagBool.
 * A flag error `take` throws (`--host requires a value`) and a leftover
 * argument both go to `report` (default usageError), and its exit code is
 * returned. `-h` / `--help` prints the usage to stdout and returns 0.
 * Otherwise returns what `take` returned.
 */
export function takeFlags<T extends object>(
  argv: readonly string[],
  usage: string,
  take: (rest: string[]) => T,
  report: ReportArgError = usageError,
): T | number {
  const rest = argv.filter((arg) => !isHelpArg(arg));
  const help = rest.length < argv.length;
  let flags: T;
  try {
    flags = take(rest);
  } catch (err) {
    return report((err as Error).message, usage);
  }
  const unknown = rejectUnknownArgs(rest, usage, report);
  if (unknown !== null) return unknown;
  if (help) {
    process.stdout.write(usage);
    return 0;
  }
  return flags;
}
