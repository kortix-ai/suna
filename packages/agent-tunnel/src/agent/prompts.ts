import { createInterface } from 'readline/promises';
import { c } from './terminal';

export function isInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

export function isTruthyFlag(value: string | undefined): boolean {
  return value === 'true' || value === '1' || value === 'yes';
}

/** True when any of `names` is set to a truthy value. */
export function anyFlag(flags: Record<string, string>, names: readonly string[]): boolean {
  return names.some((name) => isTruthyFlag(flags[name]));
}

export async function promptYesNo(question: string, defaultValue: boolean): Promise<boolean> {
  const suffix = defaultValue ? ' [Y/n] ' : ' [y/N] ';
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await rl.question(`${question}${suffix}`)).trim().toLowerCase();
      if (!answer) return defaultValue;
      if (['y', 'yes'].includes(answer)) return true;
      if (['n', 'no'].includes(answer)) return false;
      console.log(`  ${c.yellow}!${c.reset} Please answer yes or no.`);
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      process.stdout.write('\n');
      process.exit(130);
    }
    throw error;
  } finally {
    rl.close();
  }
}
