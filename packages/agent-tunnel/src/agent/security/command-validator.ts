const SHELL_METACHAR_REGEX = /[;&|`$(){}[\]<>!#~]/;

export function validateCommand(
  command: string,
  allowedCommands: string[],
  blockedCommands: string[],
): string {
  if (!command || typeof command !== 'string') {
    throw new Error('Command is required');
  }

  const trimmed = command.trim();

  if (SHELL_METACHAR_REGEX.test(trimmed)) {
    throw new Error(`Command contains disallowed characters: "${trimmed}"`);
  }

  const executable = trimmed;

  // A blocked name also blocks every path that ends in it: `/bin/rm` is `rm`.
  // Arguments stay unrestricted: an allowed `git` or `python` runs code through
  // its own flags, so a `shell` grant is local code execution, not a sandbox.
  const name = executable.slice(executable.lastIndexOf('/') + 1);
  if (blockedCommands.length > 0 && (blockedCommands.includes(executable) || blockedCommands.includes(name))) {
    throw new Error(`Command "${executable}" is blocked`);
  }

  if (allowedCommands.length > 0) {
    if (!allowedCommands.includes(executable)) {
      throw new Error(`Command "${executable}" is not in the allowed commands list`);
    }
  }

  return executable;
}
