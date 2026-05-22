export interface ParsedArgs {
  command: string;
  args: string[];
  flags: Record<string, string>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const all = argv.slice(2);
  const command = all[0] ?? 'help';
  const args: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 1; i < all.length; i++) {
    const a = all[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = all[i + 1] && !all[i + 1]!.startsWith('--') ? all[++i]! : 'true';
      flags[key] = val;
    } else {
      args.push(a);
    }
  }
  return { command, args, flags };
}

export function out(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

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

export function handleError(err: unknown): never {
  if (err instanceof CliError) {
    out({ ok: false, error: err.message, code: err.code });
    process.exit(err.exitCode);
  }
  out({ ok: false, error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}

export function validateRequired(flags: Record<string, string>, ...keys: string[]): void {
  const missing = keys.filter((k) => !flags[k]);
  if (missing.length) {
    throw new CliError(
      `Missing required: ${missing.map((k) => `--${k}`).join(', ')}`,
      'MISSING_ARGS',
    );
  }
}

export function validateUrl(url: string): void {
  try {
    new URL(url);
  } catch {
    throw new CliError(`Invalid URL: ${url}`, 'INVALID_URL');
  }
}
