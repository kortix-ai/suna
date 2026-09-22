/**
 * Port of apps/web `tool/tools/pty-read-tool.test.tsx` and
 * `pty-spawn-tool.test.tsx` over the pure logic the mobile PTY renderers
 * render from, plus `pty_write` / `pty_kill` field reads.
 */
import { describe, expect, test } from 'bun:test';
import {
  PTY_TEXT,
  earlierLinesLabel,
  parsePtyReadOutput,
  ptySpawnView,
  ptyWriteView,
  ptyKillId,
  splitTerminalBuffer,
  stripMarkupForToolOutput,
} from './files-pty';

const LONG_BUFFER = `<pty_output id="pty-1" status="running">
${Array.from({ length: 40 }, (_, i) => `line-${i + 1}`).join('\n')}
(End of buffer)
</pty_output>`;

const SHORT_BUFFER = `<pty_output id="pty-1" status="exited">
$ pnpm build
Build succeeded.
(End of buffer)
</pty_output>`;

describe('PtyReadTool folds the scrollback, keeps the tail', () => {
  test('the last 24 lines stay on screen and the rest folds behind a counted trigger', () => {
    const parsed = parsePtyReadOutput(LONG_BUFFER);
    expect(parsed.id).toBe('pty-1');
    expect(parsed.ptyStatus).toBe('running');
    expect(parsed.buffer.tail).toContain('line-40');
    expect(parsed.buffer.tail).toContain('line-17');
    expect(parsed.buffer.tail).not.toContain('line-16');
    expect(earlierLinesLabel(parsed.buffer.earlierCount)).toBe('16 earlier lines');
    expect(parsed.buffer.earlier.split('\n').at(-1)).toBe('line-16');
    expect(parsed.bufferInfo).toBe('(End of buffer)');
    expect(parsed.content).not.toContain('End of buffer');
  });

  test('a short buffer is not folded at all — there is nothing to hide', () => {
    const parsed = parsePtyReadOutput(SHORT_BUFFER);
    expect(parsed.content).toBe('$ pnpm build\nBuild succeeded.');
    expect(parsed.buffer.earlierCount).toBe(0);
  });

  test('numbered buffer lines lose their `00001|` gutter', () => {
    const parsed = parsePtyReadOutput('<pty_output id="p" status="running">\n00001| a\n00002|b\n</pty_output>');
    expect(parsed.content).toBe('a\nb');
  });

  test('output without the tag is the whole buffer, ANSI stripped', () => {
    const parsed = parsePtyReadOutput('[31mred[0m');
    expect(parsed).toMatchObject({ id: '', ptyStatus: '', content: 'red', bufferInfo: '' });
  });

  test('the row title is web en "Terminal output"', () => {
    expect(PTY_TEXT.terminalOutput).toBe('Terminal output');
  });
});

describe('splitTerminalBuffer', () => {
  test('a buffer at or under the visible height is not split', () => {
    const content = Array.from({ length: 24 }, (_, i) => `line-${i + 1}`).join('\n');
    expect(splitTerminalBuffer(content)).toEqual({ earlier: '', tail: content, earlierCount: 0 });
  });

  test('one line over, and exactly that line folds', () => {
    const content = Array.from({ length: 25 }, (_, i) => `line-${i + 1}`).join('\n');
    const split = splitTerminalBuffer(content);
    expect(split.earlierCount).toBe(1);
    expect(split.earlier).toBe('line-1');
    expect(split.tail.split('\n')).toHaveLength(24);
    expect(split.tail.endsWith('line-25')).toBe(true);
  });

  test('an empty buffer folds nothing', () => {
    expect(splitTerminalBuffer('')).toEqual({ earlier: '', tail: '', earlierCount: 0 });
  });
});

const COMMAND = 'npm run dev -- --port 3000';
const spawned = (fields: Record<string, string>) =>
  `<pty_spawned>\n${Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')}\n</pty_spawned>`;

describe('PtySpawnTool trigger drops the command once the card is showing it', () => {
  test('closed, the command is the row — open, it is the card', () => {
    const view = ptySpawnView({ command: COMMAND }, spawned({ Command: COMMAND, Status: 'running', PID: '4210' }));
    expect(view).toMatchObject({ subtitle: COMMAND, hideSubtitleWhenOpen: true, command: COMMAND });
    expect(PTY_TEXT.startedTerminal).toBe('Started terminal');
  });

  test('a model-supplied Title survives — the card never repeats it', () => {
    const view = ptySpawnView({ command: COMMAND }, spawned({ Title: 'Dev server', Command: COMMAND, Status: 'running' }));
    expect(view).toMatchObject({ subtitle: 'Dev server', hideSubtitleWhenOpen: false, command: COMMAND });
  });

  test('the process meta stays in the card, open or not', () => {
    const view = ptySpawnView(
      { command: COMMAND },
      spawned({ Command: COMMAND, Status: 'running', PID: '4210', ID: 'pty_a1b2', Workdir: '/workspace' }),
    );
    expect(view).toMatchObject({ processStatus: 'running', pid: '4210', ptyId: 'pty_a1b2', workdir: '/workspace' });
    expect(view.hasMeta).toBe(true);
  });

  test('without the tag, the input names the command and title', () => {
    expect(ptySpawnView({ command: 'ls', title: 'List' }, 'spawned')).toMatchObject({
      title: 'List',
      command: 'ls',
      subtitle: 'List',
      hasMeta: false,
    });
  });

  test('a value with a colon keeps everything after the first colon', () => {
    expect(ptySpawnView({}, spawned({ Command: 'curl http://x:3000' })).command).toBe('curl http://x:3000');
  });
});

describe('PtyWriteTool / PtyKillTool fields', () => {
  test('write reads `input` then `text`, and `id` then `pty_id`', () => {
    expect(ptyWriteView({ input: 'ls\n', id: 'pty-1' })).toEqual({ ptyInput: 'ls\n', ptyId: 'pty-1' });
    expect(ptyWriteView({ text: 'q', pty_id: 'pty-2' })).toEqual({ ptyInput: 'q', ptyId: 'pty-2' });
    expect(PTY_TEXT.terminalInput).toBe('Terminal input');
    expect(PTY_TEXT.inputPrompt).toBe('>');
  });

  test('kill reads `id` then `pty_id`', () => {
    expect(ptyKillId({ pty_id: 'pty-9' })).toBe('pty-9');
    expect(PTY_TEXT.stoppedProcess).toBe('Stopped process');
  });
});

describe('stripMarkupForToolOutput (web tool-renderers-sanitization)', () => {
  test('drops tags and collapses whitespace onto one line', () => {
    expect(stripMarkupForToolOutput('<pty_killed>\n  Killed  pty-1\n</pty_killed>')).toBe('Killed pty-1');
  });

  test('drops comments and keeps quoted `>` inside a tag', () => {
    expect(stripMarkupForToolOutput('a <!-- x --> <b title="1>2">b</b>')).toBe('a b');
  });

  test('an unterminated tag cuts the rest, as web does', () => {
    expect(stripMarkupForToolOutput('ok <broken')).toBe('ok');
  });
});
