/**
 * Collapses runs of identical lines.
 *
 * A restart loop writes the same lines thousands of times. Printing them
 * verbatim buries the one detail that matters — how many times it happened.
 */
export function collapseRepeatedLines(lines: string[]): string[] {
  const collapsed: string[] = [];
  let index = 0;
  while (index < lines.length) {
    let repeats = 1;
    while (index + repeats < lines.length && lines[index + repeats] === lines[index]) repeats++;
    collapsed.push(repeats > 1 ? `${lines[index]}  (x${repeats})` : lines[index]);
    index += repeats;
  }
  return collapsed;
}

/** Noise the supervisor's login shell writes before the agent ever starts. */
export function isShellStartupNoise(line: string): boolean {
  return /\/\.(profile|bash_profile|zprofile|zshrc|bashrc)\b.*:.*(No such file or directory|command not found)/.test(
    line,
  );
}

export function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}
