import * as readline from 'node:readline';

/**
 * Prompt the user for a project name. Called by the create command when
 * no positional name was provided. Loops until the user types something
 * non-empty. Fails fast when stdin isn't a TTY — the caller should pass
 * the project name as a positional in that case.
 */
export async function promptForProjectName(): Promise<string> {
  if (!(process.stdin.isTTY === true && process.stdout.isTTY === true)) {
    throw new Error(
      'stdin is not a TTY. Pass a project name as the first argument: `kortix my-project`.',
    );
  }
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
