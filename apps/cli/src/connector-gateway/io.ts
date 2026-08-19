/**
 * JSON-only IO helpers for the `kortix connectors` surface.
 *
 * Unlike the rest of the kortix CLI (human-formatted tables + ANSI colour),
 * `kortix connectors` is a MACHINE surface: the in-sandbox agent parses stdout.
 * So it emits ONLY JSON and never prints banners / host notices (index.ts skips
 * those for machine-oriented connector subcommands). This preserves clean JSON
 * output for agents while the implementation lives in the one CLI.
 */

export class CliError extends Error {
  constructor(
    message: string,
    public code: string = 'CLI_ERROR',
    public exitCode: number = 1,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

/** Emit a value as JSON on stdout (the connector's only output channel). */
export function out(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

export interface ExecArgs {
  command: string;
  args: string[];
  flags: Record<string, string>;
}

/**
 * Parse the args that follow `kortix connectors` into command/positional/flags.
 * `argv` is everything AFTER the `connectors` token, e.g.
 * `['call', 'stripe.charges.create', '{"amount":999}']`.
 */
export function parseExecArgs(argv: string[]): ExecArgs {
  const command = argv[0] ?? 'help';
  const args: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[(i += 1)]! : 'true';
      flags[key] = val;
    } else {
      args.push(a);
    }
  }
  return { command, args, flags };
}
