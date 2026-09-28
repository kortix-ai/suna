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
