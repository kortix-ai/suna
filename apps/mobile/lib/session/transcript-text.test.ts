import { describe, expect, test } from 'bun:test';

import type { MessageWithParts, Part } from '@/lib/opencode/types';

import {
  TRANSCRIPT_INCOMPLETE_LINE,
  TRANSCRIPT_MAX_CHARS,
  TRANSCRIPT_TRUNCATED_LINE,
  buildTranscriptText,
} from './transcript-text';

let seq = 0;
function msg(role: 'user' | 'assistant', parts: Part[], extra: Partial<MessageWithParts['info']> = {}): MessageWithParts {
  seq += 1;
  return {
    info: { id: `msg_${seq}`, role, sessionID: 'ses_1', time: { created: seq }, ...extra },
    parts,
  };
}
const text = (value: string, flags: { synthetic?: boolean; ignored?: boolean } = {}): Part =>
  ({ type: 'text', id: `prt_${++seq}`, text: value, ...flags }) as Part;
const tool = (name: string, output = 'SECRET OUTPUT'): Part =>
  ({
    type: 'tool',
    id: `prt_${++seq}`,
    callID: `call_${seq}`,
    tool: name,
    input: { command: 'SECRET INPUT' },
    state: { status: 'completed', output },
  }) as Part;
const reasoning = (value: string): Part => ({ type: 'reasoning', id: `prt_${++seq}`, text: value }) as Part;

describe('buildTranscriptText', () => {
  test('title header, then You / Kortix blocks with their text', () => {
    const out = buildTranscriptText('Fix the build', [
      msg('user', [text('Why does CI fail?')]),
      msg('assistant', [text('The lockfile is stale.')]),
    ]);
    expect(out).toBe('Fix the build\n\nYou:\nWhy does CI fail?\n\nKortix:\nThe lockfile is stale.');
  });

  test('a tool call is one line with its name only: no input, no output', () => {
    const out = buildTranscriptText('T', [msg('assistant', [text('Checking.'), tool('bash'), text('Done.')])])!;
    expect(out).toBe('T\n\nKortix:\nChecking.\nTool: bash\nDone.');
    expect(out).not.toContain('SECRET');
  });

  test('reasoning, synthetic and ignored text parts are dropped', () => {
    const out = buildTranscriptText('T', [
      msg('assistant', [reasoning('private thoughts'), text('hidden', { synthetic: true }), text('skip', { ignored: true }), text('Visible')]),
    ])!;
    expect(out).toBe('T\n\nKortix:\nVisible');
  });

  test('file contents in a user message are stripped to the visible text', () => {
    const out = buildTranscriptText('T', [
      msg('user', [text('Read this\n<file path="/w/a.txt" mime="text/plain" filename="a.txt">FILE BODY</file>')]),
    ])!;
    expect(out).toContain('You:\nRead this');
    expect(out).not.toContain('FILE BODY');
  });

  test('consecutive messages of one role share one label', () => {
    const out = buildTranscriptText('T', [
      msg('assistant', [text('One')]),
      msg('assistant', [tool('read')]),
      msg('user', [text('Two')]),
    ]);
    expect(out).toBe('T\n\nKortix:\nOne\nTool: read\n\nYou:\nTwo');
  });

  test('system messages and messages with nothing to show are skipped', () => {
    const out = buildTranscriptText('T', [
      msg('user', [text('injected')], { system: true }),
      msg('assistant', [reasoning('only thinking')]),
      msg('user', [text('Hello')]),
    ]);
    expect(out).toBe('T\n\nYou:\nHello');
  });

  test('a blank title drops the header line', () => {
    expect(buildTranscriptText('  ', [msg('user', [text('Hi')])])).toBe('You:\nHi');
  });

  test('no visible content returns null', () => {
    expect(buildTranscriptText('T', [])).toBeNull();
    expect(buildTranscriptText('T', [msg('assistant', [reasoning('x')])])).toBeNull();
  });

  test('longer than the cap: cut to the cap, then the truncated line', () => {
    const long = 'a'.repeat(TRANSCRIPT_MAX_CHARS + 500);
    const out = buildTranscriptText('T', [msg('assistant', [text(long)])])!;
    expect(out.endsWith(`\n\n${TRANSCRIPT_TRUNCATED_LINE}`)).toBe(true);
    expect(out.length).toBe(TRANSCRIPT_MAX_CHARS + `\n\n${TRANSCRIPT_TRUNCATED_LINE}`.length);
  });

  test('a custom cap applies', () => {
    const out = buildTranscriptText('Title', [msg('user', [text('0123456789')])], { maxChars: 13 })!;
    expect(out).toBe(`Title\n\nYou:\n0\n\n${TRANSCRIPT_TRUNCATED_LINE}`);
  });

  test('the cap never splits a surrogate pair', () => {
    // 'Title\n\nYou:\n' is 12 code units; the emoji takes units 12 and 13.
    const out = buildTranscriptText('Title', [msg('user', [text('😀 after')])], { maxChars: 13 })!;
    expect(out).toBe(`Title\n\nYou:\n\n${TRANSCRIPT_TRUNCATED_LINE}`);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  test('a cut on a whole emoji keeps it', () => {
    const out = buildTranscriptText('Title', [msg('user', [text('😀 after')])], { maxChars: 14 })!;
    expect(out).toBe(`Title\n\nYou:\n😀\n\n${TRANSCRIPT_TRUNCATED_LINE}`);
  });

  test('incomplete history: the note follows the title', () => {
    const out = buildTranscriptText('T', [msg('user', [text('Hi')])], { incomplete: true });
    expect(out).toBe(`T\n\n${TRANSCRIPT_INCOMPLETE_LINE}\n\nYou:\nHi`);
  });

  test('complete history: no note', () => {
    const out = buildTranscriptText('T', [msg('user', [text('Hi')])], { incomplete: false })!;
    expect(out).not.toContain(TRANSCRIPT_INCOMPLETE_LINE);
  });

  test('incomplete with no title: the note leads', () => {
    expect(buildTranscriptText('', [msg('user', [text('Hi')])], { incomplete: true })).toBe(
      `${TRANSCRIPT_INCOMPLETE_LINE}\n\nYou:\nHi`
    );
  });
});
