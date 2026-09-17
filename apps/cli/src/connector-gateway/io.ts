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

/**
 * The JSON body the connector surface prints for a FAILED command.
 *
 * A denied connector call is a remedy, not a sentence. The gateway answers 403
 * with `reason`, `requested_account`, `available_accounts`, `hint` and — when
 * nothing is connected at all — `connect_url`, the link the human opens. The
 * CLI used to emit `err.message` alone, so an agent was told
 * `connector_not_connected` and nothing about how to fix it: the one field
 * that ends the dead end never reached it. The API body now passes through
 * VERBATIM; `ok`, `error` and the CLI's own `code` are added AROUND it, never
 * over it.
 *
 * `code` is the CLI's generic slug only when the body names no `reason` of its
 * own — `reason` is the machine-readable field an agent branches on, and two
 * competing codes in one payload is worse than one.
 */
export function connectorErrorPayload(
  err: unknown,
  fallbackCode = 'CONNECTOR_ERROR',
): Record<string, unknown> {
  const body = apiErrorBody(err);
  const message = err instanceof Error ? err.message : String(err);
  return {
    ...body,
    ok: false,
    error: typeof body.error === 'string' ? body.error : message,
    ...(typeof body.reason === 'string' ? {} : { code: fallbackCode }),
  };
}

/**
 * The parsed response body carried by an `@kortix/sdk` ApiError. `details` is
 * where the SDK puts it (`data` is its documented legacy alias); anything that
 * is not a plain JSON object — an array, a string, a network error with no
 * body — carries no fields worth spreading.
 */
function apiErrorBody(err: unknown): Record<string, unknown> {
  if (!err || typeof err !== 'object') return {};
  const carrier = err as { details?: unknown; data?: unknown };
  const body = carrier.details ?? carrier.data;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  return body as Record<string, unknown>;
}
