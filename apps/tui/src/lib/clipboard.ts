/**
 * Copy to the system clipboard with whatever the box has.
 *
 * A terminal has no `navigator.clipboard`, and adding a dependency for three
 * `spawn` calls is not worth a lockfile entry. macOS ships `pbcopy`; Wayland
 * ships `wl-copy`; X11 ships `xclip` or `xsel`. None of them may exist, which
 * is a normal outcome (a headless box, a bare container), so this NEVER
 * throws: it answers which tool worked, or why nothing did, and the caller
 * toasts that.
 */

export interface ClipboardResult {
  ok: boolean;
  /** The tool that took the text, for the success toast. */
  tool?: string;
  /** Why nothing took it, for the failure toast. */
  error?: string;
}

/** Candidates in preference order. First one that exits 0 wins. */
export const CLIPBOARD_COMMANDS: readonly string[][] = [
  ['pbcopy'],
  ['wl-copy'],
  ['xclip', '-selection', 'clipboard'],
  ['xsel', '--clipboard', '--input'],
] as const;

export type ClipboardSpawn = (command: string[], text: string) => Promise<number>;

/** Feed `text` to `command` on stdin and resolve its exit code. */
const spawnClipboard: ClipboardSpawn = async (command, text) => {
  const child = Bun.spawn(command, {
    stdin: new TextEncoder().encode(text),
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return await child.exited;
};

export async function copyToClipboard(
  text: string,
  spawn: ClipboardSpawn = spawnClipboard,
): Promise<ClipboardResult> {
  const tried: string[] = [];
  for (const command of CLIPBOARD_COMMANDS) {
    const tool = command[0] as string;
    tried.push(tool);
    try {
      const code = await spawn([...command], text);
      if (code === 0) return { ok: true, tool };
    } catch {
      // Not installed, or not executable. Try the next one.
    }
  }
  return { ok: false, error: `no clipboard tool (tried ${tried.join(', ')})` };
}
