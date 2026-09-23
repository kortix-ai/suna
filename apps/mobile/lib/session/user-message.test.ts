import { describe, expect, test } from 'bun:test';

import {
  WEB_SPACING_PX,
  commandMessageText,
  extractReplyContexts,
  interruptedTurnIds,
  isUserMessageEdited,
  parseUserMessageText,
  queuedPromptStatusLabel,
  quoteMarginBottom,
  rewindHiddenMessageIds,
  userMessageMetaItems,
  webSpace,
} from './user-message';

describe('webSpace', () => {
  test('one web spacing step is 0.23rem = 3.68px', () => {
    expect(WEB_SPACING_PX).toBeCloseTo(3.68, 5);
  });

  test('converts web spacing steps to rendered pixels', () => {
    expect(webSpace(2)).toBeCloseTo(7.36, 5);
    expect(webSpace(2.5)).toBeCloseTo(9.2, 5);
    expect(webSpace(3.5)).toBeCloseTo(12.88, 5);
    expect(webSpace(28)).toBeCloseTo(103.04, 5);
  });
});

describe('parseUserMessageText', () => {
  test('plain text passes through', () => {
    const parsed = parseUserMessageText('hello');
    expect(parsed.text).toBe('hello');
    expect(parsed.quotes).toEqual([]);
    expect(parsed.files).toEqual([]);
    expect(parsed.sessions).toEqual([]);
  });

  test('extracts <file> upload tags into files and strips them', () => {
    const raw =
      'see this\n\n<file path="/workspace/uploads/a.png" mime="image/png" filename="a.png">\nThis file has been uploaded and is available at the path above.\n</file>';
    const parsed = parseUserMessageText(raw);
    expect(parsed.text).toBe('see this');
    expect(parsed.files).toEqual([
      { path: '/workspace/uploads/a.png', mime: 'image/png', filename: 'a.png' },
    ]);
  });

  test('unescapes XML attributes in file tags', () => {
    const raw = '<file path="/w/R&amp;D.pdf" mime="application/pdf" filename="R&amp;D.pdf">x</file>';
    expect(parseUserMessageText(raw).files[0]?.filename).toBe('R&D.pdf');
  });

  test('extracts a legacy single leading reply context', () => {
    const parsed = parseUserMessageText('<reply_context>quoted bit</reply_context>\nmy answer');
    expect(parsed.quotes).toEqual(['quoted bit']);
    expect(parsed.text).toBe('my answer');
  });

  test('extracts many interleaved reply_context blocks in order', () => {
    const raw =
      '<reply_context>first quoted passage</reply_context>\nmy reply to the first\n<reply_context>second quoted passage</reply_context>\nmy reply to the second';
    const parsed = parseUserMessageText(raw);
    expect(parsed.quotes).toEqual(['first quoted passage', 'second quoted passage']);
    expect(parsed.text).toBe('my reply to the first\nmy reply to the second');
  });

  test('a third block keeps ordering and strips all raw XML', () => {
    const raw =
      '<reply_context>a</reply_context>\none\n<reply_context>b</reply_context>\ntwo\n<reply_context>c</reply_context>\nthree';
    const parsed = parseUserMessageText(raw);
    expect(parsed.quotes).toEqual(['a', 'b', 'c']);
    expect(parsed.text).toBe('one\ntwo\nthree');
    expect(parsed.text).not.toContain('reply_context');
  });

  test('tolerates attributes on the open tag and surrounding whitespace, and trims the body', () => {
    const raw = '<reply_context foo="x">   quoted with attrs   </reply_context>\nreply text';
    const parsed = parseUserMessageText(raw);
    expect(parsed.quotes).toEqual(['quoted with attrs']);
    expect(parsed.text).toBe('reply text');
  });

  test('decodes an escaped closing tag inside the quote body', () => {
    const raw = '<reply_context>before &lt;/reply_context&gt; after</reply_context>\nreply text';
    const parsed = parseUserMessageText(raw);
    expect(parsed.quotes).toEqual(['before </reply_context> after']);
    expect(parsed.text).toBe('reply text');
  });

  test('an unclosed block is left as text, not parsed as a quote', () => {
    const raw = '<reply_context>never closed\nreply text';
    const parsed = parseUserMessageText(raw);
    expect(parsed.quotes).toEqual([]);
    expect(parsed.text).toBe(raw);
  });

  test('consumes only one trailing newline after a close tag, matching web stripReplyContexts', () => {
    // Expected value confirmed by running web's own function:
    // `bun -e` against apps/web/src/features/session/message-parsing.tsx
    // stripReplyContexts('<reply_context>a</reply_context>   \nrest') === 'rest'
    const raw = '<reply_context>a</reply_context>   \nrest';
    const parsed = parseUserMessageText(raw);
    expect(parsed.quotes).toEqual(['a']);
    expect(parsed.text).toBe('rest');
  });

  test('collapses a blank-line run left behind between two blocks to one blank line', () => {
    const raw = '<reply_context>a</reply_context>\n\n\nmiddle text\n\n\n<reply_context>b</reply_context>\nend';
    const parsed = parseUserMessageText(raw);
    expect(parsed.quotes).toEqual(['a', 'b']);
    expect(parsed.text).toBe('middle text\n\nend');
  });

  test('extracts session refs and strips their header', () => {
    const raw =
      'look at @Old run\n\nReferenced sessions (use the session_context tool to fetch details when needed):\n<session_ref id="ses_1" title="Old run" />';
    const parsed = parseUserMessageText(raw);
    expect(parsed.text).toBe('look at @Old run');
    expect(parsed.sessions).toEqual([{ id: 'ses_1', title: 'Old run' }]);
  });

  test('strips file_ref, agent_ref, project_ref and kortix_system blocks', () => {
    const raw =
      'hi @a.ts\n\nReferenced files (read them):\n<file_ref path="a.ts" name="a.ts" />\n<agent_ref name="build" />\n<project_ref name="x" />\n<kortix_system type="ctx">secret</kortix_system>';
    expect(parseUserMessageText(raw).text).toBe('hi @a.ts');
  });
});

describe('isUserMessageEdited', () => {
  test('true when a visible text part carries metadata.edited', () => {
    expect(
      isUserMessageEdited([{ type: 'text', text: 'x', metadata: { edited: true } }]),
    ).toBe(true);
  });

  test('ignores synthetic, ignored, and empty parts', () => {
    expect(
      isUserMessageEdited([
        { type: 'text', text: 'x', synthetic: true, metadata: { edited: true } },
        { type: 'text', text: 'y', ignored: true, metadata: { edited: true } },
        { type: 'text', text: '  ', metadata: { edited: true } },
        { type: 'file', metadata: { edited: true } },
      ]),
    ).toBe(false);
  });
});

describe('userMessageMetaItems', () => {
  const now = Date.UTC(2026, 8, 17, 12, 0, 0);

  test('relative time, then "edited"', () => {
    expect(userMessageMetaItems({ timestamp: now - 5 * 60_000, edited: true, now })).toEqual([
      '5 minutes ago',
      'edited',
    ]);
  });

  test('under a minute reads "just now"', () => {
    expect(userMessageMetaItems({ timestamp: now - 10_000, edited: false, now })).toEqual([
      'just now',
    ]);
  });

  test('no timestamp and not edited is empty', () => {
    expect(userMessageMetaItems({ timestamp: null, edited: false, now })).toEqual([]);
  });
});

describe('queuedPromptStatusLabel', () => {
  test('a plainly queued bubble has no label', () => {
    expect(queuedPromptStatusLabel('queued')).toBeNull();
  });

  test('an interrupted bubble explains itself', () => {
    expect(queuedPromptStatusLabel('interrupted')).toBe('Queued — runs with your next message');
  });
});

type T = { userMessage: { info: { id: string } }; assistantMessages: { info: { error?: unknown } }[] };
const turn = (id: string, assistant: { error?: unknown }[] = []): T => ({
  userMessage: { info: { id } },
  assistantMessages: assistant.map((info) => ({ info })),
});
const aborted = { name: 'MessageAbortedError', data: { message: 'aborted' } };

describe('interruptedTurnIds', () => {
  test('turns after an aborted turn with no answer are interrupted', () => {
    const turns = [turn('a', [{}]), turn('b', [{ error: aborted }]), turn('c'), turn('d')];
    expect([...interruptedTurnIds(turns, false)]).toEqual(['c', 'd']);
  });

  test('nothing is interrupted while the session works', () => {
    const turns = [turn('b', [{ error: aborted }]), turn('c')];
    expect(interruptedTurnIds(turns, true).size).toBe(0);
  });

  test('nothing is interrupted when the newest turn with content was not aborted', () => {
    const turns = [turn('b', [{}]), turn('c')];
    expect(interruptedTurnIds(turns, false).size).toBe(0);
  });

  test('nothing is interrupted when the last turn has content', () => {
    const turns = [turn('b', [{ error: aborted }])];
    expect(interruptedTurnIds(turns, false).size).toBe(0);
  });
});

describe('rewindHiddenMessageIds', () => {
  const msg = (id: string, created?: number) => ({ info: { id, time: created ? { created } : undefined } });

  test('the boundary and every later message, in created order', () => {
    const messages = [msg('m3', 30), msg('m1', 10), msg('m2', 20), msg('m4', 40)];
    expect(rewindHiddenMessageIds(messages, 'm2')).toEqual(['m2', 'm3', 'm4']);
  });

  test('created time wins over id order', () => {
    const messages = [msg('z', 10), msg('a', 20)];
    expect(rewindHiddenMessageIds(messages, 'z')).toEqual(['z', 'a']);
  });

  test('an unknown boundary hides nothing', () => {
    expect(rewindHiddenMessageIds([msg('a', 1)], 'nope')).toEqual([]);
  });
});

describe('extractReplyContexts (exported for the command path)', () => {
  test('returns the quotes in order and the text without any block', () => {
    expect(
      extractReplyContexts('<reply_context>first</reply_context>\nrun it\n<reply_context>second</reply_context>'),
    ).toEqual({ text: 'run it', quotes: ['first', 'second'] });
  });
});

describe('commandMessageText — a /command whose args carry quotes', () => {
  test('the body and the copy/edit text never contain raw <reply_context> XML', () => {
    const result = commandMessageText('review', '<reply_context>a passage</reply_context>\nrun it');
    expect(result.body).toBe('run it');
    expect(result.prompt).toBe('/review run it');
  });

  test('quote-only args leave an empty body and a bare /name prompt', () => {
    expect(commandMessageText('review', '<reply_context>a passage</reply_context>')).toEqual({
      body: '',
      prompt: '/review',
    });
  });

  test('plain args and no args are unchanged', () => {
    expect(commandMessageText('review', 'this file')).toEqual({ body: 'this file', prompt: '/review this file' });
    expect(commandMessageText('review', undefined)).toEqual({ body: '', prompt: '/review' });
  });

  test('the quote is drawn once: parseUserMessageText already carries it in quotes', () => {
    // The bubble draws `content.quotes`; the command body must not repeat it.
    const raw = 'Review template\n<reply_context>a passage</reply_context>\nrun it';
    expect(parseUserMessageText(raw).quotes).toEqual(['a passage']);
    expect(commandMessageText('review', '<reply_context>a passage</reply_context>\nrun it').body).not.toContain(
      'a passage',
    );
  });
});

describe('quoteMarginBottom — no trailing gap under the last quote', () => {
  test('a quote followed by another quote keeps the gap', () => {
    expect(quoteMarginBottom(0, 2, false)).toBe(webSpace(2));
  });

  test('the last quote keeps the gap only when text follows it', () => {
    expect(quoteMarginBottom(1, 2, true)).toBe(webSpace(2));
    expect(quoteMarginBottom(1, 2, false)).toBe(0);
    expect(quoteMarginBottom(0, 1, false)).toBe(0);
  });
});
