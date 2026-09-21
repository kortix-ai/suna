import { describe, expect, test } from 'bun:test';

import { CLIPBOARD_COMMANDS, copyToClipboard } from './clipboard.ts';

describe('copyToClipboard', () => {
  test('uses the first tool that exits 0', async () => {
    const tried: string[][] = [];
    const result = await copyToClipboard('kortix sessions connect s1', async (command) => {
      tried.push(command);
      return command[0] === 'pbcopy' ? 0 : 1;
    });
    expect(result).toEqual({ ok: true, tool: 'pbcopy' });
    expect(tried).toEqual([['pbcopy']]);
  });

  test('falls through a missing tool to the next one', async () => {
    const tried: string[] = [];
    const result = await copyToClipboard('x', async (command) => {
      tried.push(command[0] as string);
      if (command[0] === 'pbcopy') throw new Error('ENOENT');
      if (command[0] === 'wl-copy') return 1;
      return 0;
    });
    expect(result).toEqual({ ok: true, tool: 'xclip' });
    expect(tried).toEqual(['pbcopy', 'wl-copy', 'xclip']);
  });

  test('a box with no clipboard tool answers, it does not throw', async () => {
    const result = await copyToClipboard('x', async () => {
      throw new Error('ENOENT');
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      `no clipboard tool (tried ${CLIPBOARD_COMMANDS.map((c) => c[0]).join(', ')})`,
    );
  });
});
