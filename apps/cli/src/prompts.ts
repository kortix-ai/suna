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
