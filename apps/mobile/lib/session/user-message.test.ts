import { describe, expect, test } from 'bun:test';
import { serializePromptWithPastes } from '@kortix/shared';

import {
  WEB_SPACING_PX,
  buildSessionRefsBlock,
  commandMessageText,
  editResendAttachments,
  extractReplyContexts,
  interruptedTurnIds,
  isUserMessageEdited,
  parseUserMessageText,
  parseUserMessageParts,
  queuedPromptStatusLabel,
  quoteMarginBottom,
  rewindHiddenMessageIds,
  userMessageCopyText,
  userMessageSentLabel,
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

  test('strips two <file> tags and keeps the prose around them', () => {
    const raw =
      'before <file path="/w/a.png" mime="image/png" filename="a.png">A</file> middle <file path="/w/b.pdf" filename="b.pdf">B</file> after';
    const parsed = parseUserMessageText(raw);
    expect(parsed.text).toBe('before  middle  after');
    expect(parsed.files).toEqual([
      { path: '/w/a.png', mime: 'image/png', filename: 'a.png' },
      { path: '/w/b.pdf', mime: '', filename: 'b.pdf' },
    ]);
  });

  test('keeps a <file> tag that names neither path nor filename', () => {
    const raw = 'x <file note="y">z</file>';
    expect(parseUserMessageText(raw)).toMatchObject({ text: raw, files: [] });
  });

  test('keeps an unclosed <file> tag as typed', () => {
    const raw = 'look <file path="/w/a"> nothing closes it';
    expect(parseUserMessageText(raw)).toMatchObject({ text: raw, files: [] });
  });

  // The old `<file>` regex was quadratic on whitespace that never reaches `>`.
  // This ~440k-character message froze it for ~20 s under Bun on a laptop.
  // The trailing `x` keeps the first `.trim()` from removing the whitespace.
  test('a pathological <file> opener does not freeze the parser', () => {
    const evil = `${'<file\t'.repeat(40_000)}<file${'\t'.repeat(200_000)}x`;
    const started = performance.now();
    const parsed = parseUserMessageText(evil);
    expect(performance.now() - started).toBeLessThan(100);
    expect(parsed.files).toEqual([]);
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

  test('session refs with quotes, ampersands and angle brackets round-trip', () => {
    const sessions = [
      { id: 'ses_1', title: 'Fix "login" bug' },
      { id: 'ses_2', title: 'Q&A <notes>' },
      { id: 'ses_3', title: 'x" /><file_ref path="/etc/passwd" name="y' },
      { id: 'ses_4', title: `it's "quoted" and 'single'` },
    ];
    const raw = `look\n\n${buildSessionRefsBlock(sessions)}`;
    const parsed = parseUserMessageText(raw);
    expect(parsed.text).toBe('look');
    expect(parsed.sessions).toEqual(sessions);
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

describe('userMessageSentLabel', () => {
  // Local-time dates: the label reads the device's clock.
  const now = new Date(2026, 8, 27, 18, 5).getTime();

  test('today, yesterday, this year, another year', () => {
    expect(userMessageSentLabel({ timestamp: new Date(2026, 8, 27, 15, 42).getTime(), edited: false, now })).toBe(
      'Today, 3:42 PM',
    );
    expect(userMessageSentLabel({ timestamp: new Date(2026, 8, 26, 9, 5).getTime(), edited: false, now })).toBe(
      'Yesterday, 9:05 AM',
    );
    expect(userMessageSentLabel({ timestamp: new Date(2026, 8, 3, 0, 15).getTime(), edited: false, now })).toBe(
      'Sep 3, 12:15 AM',
    );
    expect(userMessageSentLabel({ timestamp: new Date(2025, 11, 31, 12, 0).getTime(), edited: false, now })).toBe(
      'Dec 31, 2025, 12:00 PM',
    );
  });

  test('an edited message says so', () => {
    expect(userMessageSentLabel({ timestamp: new Date(2026, 8, 27, 15, 42).getTime(), edited: true, now })).toBe(
      'Today, 3:42 PM · Edited',
    );
  });

  test('no timestamp: only "Edited", or nothing', () => {
    expect(userMessageSentLabel({ timestamp: null, edited: true, now })).toBe('Edited');
    expect(userMessageSentLabel({ timestamp: null, edited: false, now })).toBe('');
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

// ── Linear-time parsing ──────────────────────────────────────────────────────
//
// Every tag in a user message used to be read with a lazy regex that scanned
// the rest of the message again for each tag that never closed. This is the
// regex version of parseUserMessageText, kept ONLY as a parity oracle.
// The multi-quote regex version of extractReplyContexts, kept ONLY as a parity
// oracle. Its lazy body re-scanned the rest of the message for every opener
// that never closed.
function legacyExtractReplyContexts(text: string): { text: string; quotes: string[] } {
  const quotes: string[] = [];
  const stripped = text.replace(/<reply_context\b[^>]*>([\s\S]*?)<\/reply_context>\n?/g, (_whole, body: string) => {
    quotes.push(body.trim().replace(/&lt;\/reply_context&gt;/g, '</reply_context>'));
    return '';
  });
  return { text: stripped.replace(/\n{3,}/g, '\n\n').trim(), quotes };
}

function legacyParse(raw: string) {
  const unescape = (v: string) => v.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  let text = (raw ?? '').replace(/<kortix_system[^>]*>[\s\S]*?<\/kortix_system>/gi, '');
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  const reply = legacyExtractReplyContexts(text);
  text = reply.text;
  const quotes = reply.quotes;
  const files: { path: string; mime: string; filename: string }[] = [];
  text = text
    .replace(/<file\s+([^>]*?)>\s*[\s\S]*?<\/file>/g, (whole, attrs: string) => {
      const pick = (key: string) => {
        const m = attrs.match(new RegExp(`\\b${key}="([^"]*?)"`));
        return m ? unescape(m[1]!) : undefined;
      };
      const path = pick('path');
      const filename = pick('filename');
      if (path === undefined && filename === undefined) return whole;
      files.push({ path: path ?? '', mime: pick('mime') ?? '', filename: filename ?? '' });
      return '';
    })
    .trim();
  text = text
    .replace(/<project_ref\b[\s\S]*?\/>/g, '')
    .replace(/\n*Referenced projects \([^)]*\):\n?/g, '')
    .replace(/<file_ref\b[\s\S]*?\/>/g, '')
    .replace(/\n*Referenced files \([^)]*\):\n?/g, '')
    .replace(/<agent_ref\b[\s\S]*?\/>/g, '')
    .replace(/\n*Referenced agents \([^)]*\):\n?/g, '')
    .trim();
  const sessions: { id: string; title: string }[] = [];
  text = text
    .replace(/<session_ref\s+id="([^"]*?)"\s+title="([^"]*?)"\s*\/>/g, (_, id: string, title: string) => {
      sessions.push({ id, title });
      return '';
    })
    .replace(/\n*Referenced sessions \(use the session_context tool to fetch details when needed\):\n?/g, '')
    .trim();
  return { text, quotes, files, sessions };
}

/** Deterministic PRNG (mulberry32), so a failing case reproduces. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('parseUserMessageText returns exactly what the regex version returned', () => {
  test('on 3000 random messages', () => {
    const tokens = ['<kortix_system type="a">', '</kortix_system>', '<KORTIX_SYSTEM', '</Kortix_System>', '<reply_context>',
      '</reply_context>', '<reply_context a="1">', '<reply_contextx>', '&lt;/reply_context&gt;', 'quoted', '<file path="/w/a.png" mime="image/png" filename="a.png">', '<file note="x">', '</file>',
      '<file', '<project_ref name="p"/>', '<project_ref', '<file_ref path="a.ts" name="a"/>', '<agent_ref name="build"/>', '/>',
      '\nReferenced projects (x):\n', 'Referenced files (', '):', '\nReferenced agents (a):', '<session_ref id="s" title="t" />',
      '\nReferenced sessions (use the session_context tool to fetch details when needed):\n', '\n', '\n\n\n', ' ', 'hello', '>'];
    const next = random(71);
    let tagged = 0;
    for (let i = 0; i < 3000; i++) {
      let text = '';
      const length = Math.floor(next() * 18);
      for (let j = 0; j < length; j++) text += tokens[Math.floor(next() * tokens.length)];
      const expected = legacyParse(text);
      const { pasted, ...parsed } = parseUserMessageText(text);
      expect(pasted).toEqual([]);
      expect(parsed).toEqual(expected);
      if (expected.text !== text.trim()) tagged++;
    }
    expect(tagged).toBeGreaterThan(1500);
  });
});

describe('extractReplyContexts returns exactly what its regex version returned', () => {
  test('on 3000 random strings of reply_context fragments', () => {
    const tokens = ['<reply_context>', '</reply_context>', '<reply_context', '<reply_context a="1">', '<reply_contextx>',
      '<reply_context-x>', '<REPLY_CONTEXT>', '</reply_context', '&lt;/reply_context&gt;', '>', ' ', '\n', '\n\n\n', 'quoted', 'answer'];
    const next = random(117);
    let matched = 0;
    for (let i = 0; i < 3000; i++) {
      let text = '';
      const length = Math.floor(next() * 20);
      for (let j = 0; j < length; j++) text += tokens[Math.floor(next() * tokens.length)];
      const expected = legacyExtractReplyContexts(text);
      expect(extractReplyContexts(text)).toEqual(expected);
      if (expected.quotes.length > 0) matched++;
    }
    expect(matched).toBeGreaterThan(800);
  });
});

describe('no user message can freeze the app', () => {
  const within = (label: string, run: () => unknown) =>
    test(label, () => {
      const started = performance.now();
      run();
      expect(performance.now() - started).toBeLessThan(100);
    });

  // Each took ~1 s with Bun on a laptop, and quadrupled per doubling. Hermes
  // on a phone is slower.
  within('16k <kortix_system> openers that never close', () => parseUserMessageText('<kortix_system>'.repeat(16_000)));
  within('16k <reply_context> openers that never close', () => parseUserMessageText('<reply_context>'.repeat(16_000)));
  within('16k <reply_context> openers that never close, extracted directly', () =>
    extractReplyContexts('<reply_context>'.repeat(16_000)));
  within('one <reply_context opener and 240k characters with no >', () =>
    extractReplyContexts(`<reply_context${' '.repeat(240_000)}x`));
  within('a /command whose args hold 16k unclosed <reply_context> openers', () =>
    commandMessageText('review', '<reply_context>'.repeat(16_000)));
  within('16k <project_ref openers that never close', () => parseUserMessageText('<project_ref x>'.repeat(16_000)));
  within('20k <file_ref openers that never close', () => parseUserMessageText('<file_ref x>'.repeat(20_000)));
  // Removing the refs joins their blank lines into one 60k-newline run, and
  // `\n*Referenced …` retried every newline of it.
  within('30k project refs, each after a blank line', () => parseUserMessageText('\n\n<project_ref x/>'.repeat(30_000)));
  within('30k session refs, each after a blank line', () =>
    parseUserMessageText('\n\n<session_ref id="a" title="b" />'.repeat(30_000)));
});


describe('parseUserMessageParts', () => {
  test('merges file tags before file parts and filters synthetic, ignored and empty text', () => {
    const parts = [
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'synthetic', synthetic: true },
      { type: 'text', text: 'ignored', ignored: true },
      { type: 'text', text: '  ' },
      { type: 'text', text: '<file path="/w/a.png" mime="image/png" filename="a.png">x</file>' },
      { type: 'file', id: 'file-1', filename: 'other.pdf', mime: 'application/pdf', url: 'https://example.test/file', localUri: 'file:///tmp/other.pdf' },
    ];
    expect(parseUserMessageParts(parts as Parameters<typeof parseUserMessageParts>[0])).toEqual({
      rawText: 'hello\n<file path="/w/a.png" mime="image/png" filename="a.png">x</file>',
      content: { text: 'hello', quotes: [], sessions: [], files: [{ path: '/w/a.png', mime: 'image/png', filename: 'a.png' }], pasted: [] },
      attachments: [
        { key: 'upload:0:/w/a.png', filename: 'a.png', mime: 'image/png', src: '/w/a.png', path: '/w/a.png' },
        { key: 'file-1', filename: 'other.pdf', mime: 'application/pdf', src: 'https://example.test/file', localUri: 'file:///tmp/other.pdf' },
      ],
    });
  });
});

// Synthetic ids only.
const SAVED_COPY =
  'kortix-attachment://00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/00000000-0000-4000-8000-000000000003';

describe('parseUserMessageParts — an upload ref keeps its path and saved copy', () => {
  test('the tile carries the workspace path and the kortix-attachment ref; src stays the path', () => {
    const text = `<file path="/workspace/uploads/.kortix-inbox/a.png" mime="image/png" filename="a.png" attachment="${SAVED_COPY}">x</file>`;
    const { attachments } = parseUserMessageParts([{ type: 'text', text }] as unknown as Parameters<typeof parseUserMessageParts>[0]);
    expect(attachments).toEqual([
      {
        key: 'upload:0:/workspace/uploads/.kortix-inbox/a.png',
        filename: 'a.png',
        mime: 'image/png',
        src: '/workspace/uploads/.kortix-inbox/a.png',
        path: '/workspace/uploads/.kortix-inbox/a.png',
        attachment: SAVED_COPY,
      },
    ]);
  });
});

describe('editResendAttachments — what an edited prompt sends again (KRTX-962)', () => {
  const savedCopy = { key: 'u0', filename: 'a.png', mime: 'image/png', src: '/w/a.png', path: '/w/a.png', attachment: SAVED_COPY };
  const pathOnly = { key: 'u1', filename: 'b.pdf', mime: 'application/pdf', src: '/w/b.pdf', path: '/w/b.pdf' };
  const PATH_ONLY_REF = '<file path="/w/b.pdf" mime="application/pdf" filename="b.pdf">\nThis file has been uploaded and is available at the path above.\n</file>';
  const nativePart = { key: 'f1', filename: 'c.txt', mime: 'text/plain', src: 'https://example.test/c.txt' };

  test('a saved copy resends as a URL part with the kortix-attachment ref', () => {
    expect(editResendAttachments([savedCopy], '')).toEqual({
      fileParts: [{ type: 'file', mime: 'image/png', url: SAVED_COPY, filename: 'a.png' }],
      text: '',
    });
  });

  test('a native file part resends as a URL part with its own url', () => {
    expect(editResendAttachments([nativePart], '')).toEqual({
      fileParts: [{ type: 'file', mime: 'text/plain', url: 'https://example.test/c.txt', filename: 'c.txt' }],
      text: '',
    });
  });

  test('a path-only upload resends its <file> ref as text', () => {
    expect(editResendAttachments([pathOnly], '')).toEqual({
      fileParts: [],
      text: PATH_ONLY_REF,
    });
  });

  test('the text joins the refs: unchanged with none, trimmed text first, refs alone for blank text', () => {
    expect(editResendAttachments([], '  hi  ').text).toBe('  hi  ');
    expect(editResendAttachments([pathOnly], ' hi ').text).toBe(`hi\n\n${PATH_ONLY_REF}`);
    expect(editResendAttachments([pathOnly], '   ').text).toBe(PATH_ONLY_REF);
    expect(editResendAttachments([pathOnly], '').text).toBe(PATH_ONLY_REF);
  });

  test('a tile with no source has nothing to resend; a missing mime falls back to octet-stream', () => {
    expect(editResendAttachments([{ key: 'x', filename: 'x', localUri: 'file:///x' }], '')).toEqual({ fileParts: [], text: '' });
    expect(editResendAttachments([{ key: 'y', filename: 'y.bin', mime: '', src: 'https://example.test/y' }], '').fileParts).toEqual([
      { type: 'file', mime: 'application/octet-stream', url: 'https://example.test/y', filename: 'y.bin' },
    ]);
  });

  test('a removed tile is not sent: only the kept ones go, in order', () => {
    const all = [savedCopy, pathOnly, nativePart];
    const kept = all.filter((tile) => tile.key !== 'u0');
    const { fileParts, text } = editResendAttachments(kept, '');
    expect(fileParts.map((part) => part.url)).toEqual(['https://example.test/c.txt']);
    expect(text).toContain('path="/w/b.pdf"');
    expect(text).not.toContain('a.png');
    expect(editResendAttachments([], 'hi')).toEqual({ fileParts: [], text: 'hi' });
  });
});

// Synthetic paste only.
const PASTE = { id: '0a1b2c3d', text: 'line one\nline two\n<file path="/w/x.png" mime="image/png" filename="x.png">x</file>' };

describe('pasted text — `<pasted_content>` blocks become tiles', () => {
  test('parseUserMessageText takes the pastes out first; a tag inside a paste stays paste text', () => {
    const parsed = parseUserMessageText(serializePromptWithPastes('my question', [PASTE]));
    expect(parsed.text).toBe('my question');
    expect(parsed.pasted).toEqual([PASTE]);
    expect(parsed.files).toEqual([]);
  });

  test('a pastes-only message has no text', () => {
    const parsed = parseUserMessageText(serializePromptWithPastes('', [PASTE]));
    expect(parsed).toMatchObject({ text: '', pasted: [PASTE] });
  });

  test('a tag the user typed (neutralized on send) stays text, not a tile', () => {
    const parsed = parseUserMessageText(serializePromptWithPastes('<pasted_content id="x" chars="1">\na\n</pasted_content>', []));
    expect(parsed.pasted).toEqual([]);
    expect(parsed.text).toContain('pasted_content');
  });

  test('parseUserMessageParts draws each paste as a tile ahead of the files', () => {
    const text = `${serializePromptWithPastes('hi', [PASTE])}\n\n<file path="/w/a.png" mime="image/png" filename="a.png">x</file>`;
    const { content, attachments } = parseUserMessageParts([{ type: 'text', text }] as unknown as Parameters<typeof parseUserMessageParts>[0]);
    expect(content.text).toBe('hi');
    expect(attachments.map((a) => a.key)).toEqual(['pasted:0a1b2c3d', 'upload:0:/w/a.png']);
    expect(attachments[0]).toEqual({ key: 'pasted:0a1b2c3d', filename: 'Pasted text', pasted: PASTE });
  });

  test('a paste repeated (a command template repeats its args) is one tile, sent once on edit', () => {
    const block = serializePromptWithPastes('', [PASTE]);
    const text = `${block}\n\nrun it\n\n${block}`;
    const { content, attachments } = parseUserMessageParts([{ type: 'text', text }] as unknown as Parameters<typeof parseUserMessageParts>[0]);
    expect(content.pasted).toEqual([PASTE]);
    expect(attachments.map((a) => a.key)).toEqual(['pasted:0a1b2c3d']);
    expect(editResendAttachments(attachments, 'run it').text).toBe(serializePromptWithPastes('run it', [PASTE]));
  });

  test('Copy writes each paste as its text, then the typed text', () => {
    expect(userMessageCopyText('my question', [PASTE])).toBe(`${PASTE.text}\n\nmy question`);
    expect(userMessageCopyText('', [PASTE])).toBe(PASTE.text);
    expect(userMessageCopyText('plain', [])).toBe('plain');
  });

  test('an edit resends a kept paste as its block ahead of the text; a removed one is gone', () => {
    const tile = { key: 'pasted:0a1b2c3d', filename: 'Pasted text', pasted: PASTE };
    expect(editResendAttachments([tile], 'edited')).toEqual({
      fileParts: [],
      text: serializePromptWithPastes('edited', [PASTE]),
    });
    expect(editResendAttachments([], 'edited').text).toBe('edited');
  });

  test('a command body never shows the paste XML', () => {
    const result = commandMessageText('review', serializePromptWithPastes('run it', [PASTE]));
    expect(result).toEqual({ body: 'run it', prompt: '/review run it' });
  });
});
