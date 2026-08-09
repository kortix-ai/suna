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

  if (blockedCommands.length > 0 && blockedCommands.includes(executable)) {
    throw new Error(`Command "${executable}" is blocked`);
  }

  if (allowedCommands.length > 0) {
    if (!allowedCommands.includes(executable)) {
      throw new Error(`Command "${executable}" is not in the allowed commands list`);
    }
  }

  return executable;
}
