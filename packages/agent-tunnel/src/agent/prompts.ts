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
