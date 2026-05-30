import * as readline from 'node:readline';

function ensureTTY(): void {
  if (!(process.stdin.isTTY === true && process.stdout.isTTY === true)) {
    throw new Error(
      'stdin is not a TTY. Pass arguments / flags directly, or run with --yes to accept defaults.',
    );
  }
}

/**
 * Plain-text prompt with optional default. Returns whatever the user
 * typed (trimmed), or `defaultValue` when they hit enter.
 */
export async function prompt(label: string, defaultValue?: string): Promise<string> {
  ensureTTY();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = defaultValue !== undefined ? ` (${defaultValue})` : '';
    const raw = await new Promise<string>((resolve) =>
      rl.question(`${label}${suffix}: `, (answer) => resolve(answer)),
    );
    const trimmed = raw.trim();
    return trimmed !== '' ? trimmed : defaultValue ?? '';
  } finally {
    rl.close();
  }
}

/**
 * Masked prompt for sensitive input (e.g. secret values). The label is
 * printed, but keystrokes aren't echoed — nothing about the value lands in
 * the terminal scrollback. Returns the raw value (NOT trimmed — secrets may
 * legitimately have leading/trailing whitespace; only a trailing newline is
 * stripped by readline itself).
 */
export async function promptSecret(label: string): Promise<string> {
  ensureTTY();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  let muted = false;
  // Swallow keystroke echoes once the question has been written. readline
  // calls `_writeToOutput` for both the prompt and every typed character; we
  // let the prompt through, then mute everything after.
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = function (
    this: { output: NodeJS.WritableStream },
    str: string,
  ) {
    if (!muted) this.output.write(str);
  };
  try {
    const value = await new Promise<string>((resolve) => {
      rl.question(`${label}: `, (answer) => resolve(answer));
      muted = true; // question() writes the prompt synchronously above
    });
    process.stdout.write('\n'); // the muted Enter never printed a newline
    return value;
  } finally {
    rl.close();
  }
}

/**
 * Yes/no confirmation. Returns the boolean answer; treats blank input
 * as `defaultValue`. Accepts y/yes/n/no (case-insensitive).
 */
export async function confirm(label: string, defaultValue: boolean): Promise<boolean> {
  ensureTTY();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const hint = defaultValue ? 'Y/n' : 'y/N';
    while (true) {
      const raw = await new Promise<string>((resolve) =>
        rl.question(`${label} [${hint}]: `, (answer) => resolve(answer)),
      );
      const normalized = raw.trim().toLowerCase();
      if (normalized === '') return defaultValue;
      if (['y', 'yes'].includes(normalized)) return true;
      if (['n', 'no'].includes(normalized)) return false;
      process.stdout.write('  Type y or n.\n');
    }
  } finally {
    rl.close();
  }
}

/**
 * Pick one value from a fixed list. Returns the chosen value
 * (lowercased + trimmed). Empty input falls back to `defaultValue`.
 * Re-prompts on unknown values.
 */
export async function selectFrom<T extends string>(
  label: string,
  options: readonly T[],
  defaultValue: T,
): Promise<T> {
  ensureTTY();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const raw = await new Promise<string>((resolve) =>
        rl.question(`${label} [${defaultValue}]: `, (answer) => resolve(answer)),
      );
      const norm = raw.trim().toLowerCase();
      if (norm === '') return defaultValue;
      if ((options as readonly string[]).includes(norm)) return norm as T;
      process.stdout.write(`  Pick one of: ${options.join(', ')}\n`);
    }
  } finally {
    rl.close();
  }
}

/**
 * Comma-separated multi-select against a fixed list. Empty input
 * returns `[]`. Unknown / duplicate entries are dropped silently.
 */
export async function selectMany<T extends string>(
  label: string,
  options: readonly T[],
): Promise<T[]> {
  ensureTTY();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const raw = await new Promise<string>((resolve) =>
      rl.question(`${label}: `, (answer) => resolve(answer)),
    );
    const seen = new Set<T>();
    const out: T[] = [];
    for (const part of raw.split(',')) {
      const norm = part.trim().toLowerCase() as T;
      if (!norm || seen.has(norm)) continue;
      if (!(options as readonly string[]).includes(norm)) continue;
      seen.add(norm);
      out.push(norm);
    }
    return out;
  } finally {
    rl.close();
  }
}

/**
 * Loop-until-non-empty prompt. Used when the answer is mandatory.
 */
export async function promptForProjectName(): Promise<string> {
  ensureTTY();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const raw = await new Promise<string>((resolve) =>
        rl.question('Project name: ', (answer) => resolve(answer)),
      );
      const trimmed = raw.trim();
      if (trimmed !== '') return trimmed;
      process.stdout.write('  Project name is required.\n');
    }
  } finally {
    rl.close();
  }
}
