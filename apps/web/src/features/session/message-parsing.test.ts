import { describe, expect, test } from 'bun:test';

import {
  parseAgentMentionReferences,
  parseFileMentionReferences,
  parseFileReferences,
  parseProjectReferences,
  parseReplyContexts,
  parseSessionReferences,
  parseSystemNotifications,
  parseTriggerEvent,
  QUOTE_MARKER_RE,
  quoteMarker,
  serializeReplyContext,
  splitAtQuoteMarkers,
  stripReplyContexts,
  systemNotificationSeverity,
} from './message-parsing';

describe('parseFileReferences', () => {
  test('unescapes every attribute it hands back', () => {
    // The sibling `parseFileMentionReferences` always unescaped; this one
    // pushed the raw attribute out, so `R&D report.pdf` reached the transcript
    // — and the model — as `R&amp;D report.pdf`.
    const { files, cleanText } = parseFileReferences(
      'read it\n\n<file path="/workspace/uploads/R&amp;D.pdf" mime="application/pdf" filename="R&amp;D report.pdf">\nblurb\n</file>',
    );

    expect(cleanText).toBe('read it');
    expect(files).toEqual([
      { path: '/workspace/uploads/R&D.pdf', mime: 'application/pdf', filename: 'R&D report.pdf' },
    ]);
  });

  test('reads the attachment identity off a sent ref', () => {
    const { files } = parseFileReferences(
      '<file path="" mime="image/png" filename="image.png" attachment="upload-1">\nx\n</file>',
    );

    expect(files).toEqual([
      { path: '', mime: 'image/png', filename: 'image.png', attachment: 'upload-1' },
    ]);
  });

  test('a tag with no path and no filename is left in the text', () => {
    // Attributes are read by name now. A `<file>` block that carries neither is
    // not a file reference, and swallowing it would delete message content.
    const input = '<file foo="bar">\nnot a ref\n</file>';
    expect(parseFileReferences(input)).toEqual({ cleanText: input, files: [] });
  });
});

describe('parseReplyContexts / serializeReplyContext / stripReplyContexts / splitAtQuoteMarkers', () => {
  const threeInterleaved =
    '<reply_context>Q1</reply_context>\nreply one\n<reply_context>Q2</reply_context>\nreply two\n<reply_context>Q3</reply_context>\nreply three';

  test('no block leaves the text untouched', () => {
    const text = 'just a plain message';
    expect(parseReplyContexts(text)).toEqual({ cleanText: text, quotes: [] });
  });

  test('a legacy single leading block parses like before', () => {
    const { cleanText, quotes } = parseReplyContexts('<reply_context>A</reply_context>\n\nhello');
    expect(quotes).toEqual(['A']);
    expect(splitAtQuoteMarkers(cleanText, quotes)).toEqual([
      { kind: 'quote', text: 'A', index: 0 },
      { kind: 'text', text: 'hello' },
    ]);
  });

  test('three interleaved blocks parse and split in document order', () => {
    const { cleanText, quotes } = parseReplyContexts(threeInterleaved);
    expect(quotes).toEqual(['Q1', 'Q2', 'Q3']);
    expect(splitAtQuoteMarkers(cleanText, quotes)).toEqual([
      { kind: 'quote', text: 'Q1', index: 0 },
      { kind: 'text', text: 'reply one' },
      { kind: 'quote', text: 'Q2', index: 1 },
      { kind: 'text', text: 'reply two' },
      { kind: 'quote', text: 'Q3', index: 2 },
      { kind: 'text', text: 'reply three' },
    ]);
  });

  test('two adjacent blocks with no text between produce no empty text piece', () => {
    const { cleanText, quotes } = parseReplyContexts(
      '<reply_context>A</reply_context>\n<reply_context>B</reply_context>',
    );
    expect(splitAtQuoteMarkers(cleanText, quotes)).toEqual([
      { kind: 'quote', text: 'A', index: 0 },
      { kind: 'quote', text: 'B', index: 1 },
    ]);
  });

  test('a quote body carrying markup and a newline survives verbatim', () => {
    const { quotes } = parseReplyContexts('<reply_context><b>x</b>\nmore</reply_context>\ntext');
    expect(quotes).toEqual(['<b>x</b>\nmore']);
  });

  test('round-trips a quote containing a literal closing tag', () => {
    const wire = serializeReplyContext('a </reply_context> b');
    const { quotes } = parseReplyContexts(wire);
    expect(quotes).toEqual(['a </reply_context> b']);
  });

  test('an open tag with attributes still parses', () => {
    const { quotes } = parseReplyContexts('<reply_context foo="x">stuff</reply_context>');
    expect(quotes).toEqual(['stuff']);
  });

  test('stripReplyContexts leaves only the reply text, no blank-line runs', () => {
    expect(stripReplyContexts(threeInterleaved)).toBe('reply one\nreply two\nreply three');
  });

  test('an unclosed block is left as plain text', () => {
    const text = '<reply_context>oops, never closed';
    expect(parseReplyContexts(text)).toEqual({ cleanText: text, quotes: [] });
  });

  test('parseSystemNotifications finds nothing left behind after parseReplyContexts (regression: 2nd block became a card)', () => {
    const { cleanText } = parseReplyContexts(threeInterleaved);
    const { notifications } = parseSystemNotifications(cleanText);
    expect(notifications).toEqual([]);
  });

  test('quoteMarker output round-trips through splitAtQuoteMarkers', () => {
    const text = `${quoteMarker(0)}hello`;
    expect(splitAtQuoteMarkers(text, ['Q'])).toEqual([
      { kind: 'quote', text: 'Q', index: 0 },
      { kind: 'text', text: 'hello' },
    ]);
  });

  // Regression guard for a review finding: the marker regex must be built
  // from an escape form that stays a code-point match even when replayed
  // WITHOUT the `u` flag (`QUOTE_MARKER_RE.source` reconstructed via
  // `new RegExp(...)` with no flags argument, then a fresh `g`). A
  // `\u{XXXX}` brace-form escape only means "match this code point" under
  // the `u`/`v` flag; outside it, `\u{e000}` parses as the identity escape
  // `u` followed by the literal text `{e000}` (verified with plain
  // node/bun: `/\u{e000}/.test('u{e000}')` is `true`). `QUOTE_MARKER_RE` is
  // written with the 4-hex-digit `` form instead, which is a real
  // code-point escape in every mode, so this must hold with or without `u`.
  test('the marker regex source matches its own marker even reconstructed without the u flag', () => {
    const bare = new RegExp(QUOTE_MARKER_RE.source, 'g');
    expect(bare.flags.includes('u')).toBe(false);
    const marker = quoteMarker(3);
    bare.lastIndex = 0;
    const match = bare.exec(marker);
    expect(match?.[1]).toBe('3');
  });
});

describe('parseSystemNotifications', () => {
  test('turns a tag into a sentence, not a headline', () => {
    // SystemNotificationCard prints this label verbatim in the chat stream, so
    // it has to read like something a person wrote — "Task failed", not the
    // Title Case "Task Failed" that reads like a status enum.
    const { notifications } = parseSystemNotifications(
      '<task_failed>\nExit code: 1\n</task_failed>',
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0].label).toBe('Task failed');
    expect(notifications[0].tag).toBe('task_failed');
  });

  test('splits header fields from the body on the first blank line', () => {
    const { notifications } = parseSystemNotifications(
      `<task_failed>
Command: pnpm test
Exit code: 1

FAIL src/routes/sessions.test.ts
  expected 402, received 500
</task_failed>`,
    );

    expect(notifications[0].fields).toEqual([
      ['Command', 'pnpm test'],
      ['Exit code', '1'],
    ]);
    expect(notifications[0].body).toBe(
      'FAIL src/routes/sessions.test.ts\n  expected 402, received 500',
    );
  });

  test('a line that is not Key: value ends the header', () => {
    const { notifications } = parseSystemNotifications(
      '<blocker_raised>\nSTAGING_DATABASE_URL is unset.\nSet it before promoting.\n</blocker_raised>',
    );

    expect(notifications[0].fields).toEqual([]);
    expect(notifications[0].body).toBe('STAGING_DATABASE_URL is unset.\nSet it before promoting.');
  });

  test('lifts every tag out of the text and leaves the prose behind', () => {
    const { cleanText, notifications } = parseSystemNotifications(
      'Done with the refactor.\n\n<task_completed>\nTask: Refactor the parser\n</task_completed>\n\n<snapshot_build_queued>\nProvider: daytona\n</snapshot_build_queued>',
    );

    expect(cleanText).toBe('Done with the refactor.');
    expect(notifications.map((n) => n.label)).toEqual(['Task completed', 'Snapshot build queued']);
  });

  test('text with no tags is returned untouched', () => {
    const { cleanText, notifications } = parseSystemNotifications('Just a normal message.');

    expect(cleanText).toBe('Just a normal message.');
    expect(notifications).toEqual([]);
  });
});

describe('systemNotificationSeverity', () => {
  test('spends red on the session being unable to continue', () => {
    for (const tag of [
      'task_failed',
      'sandbox_crashed',
      'quota_exceeded',
      'credentials_missing',
      'permission_denied',
      'token_expired',
      'api_key_revoked',
      'connection_lost',
      'upstream_unreachable',
      'request_timed_out',
    ]) {
      expect(systemNotificationSeverity(tag)).toBe('error');
    }
  });

  test('degraded or waiting-on-the-human is amber, not red', () => {
    // A blocker is not a failure. Nothing broke — the session is waiting on the
    // person reading the row, which is a different thing to tell them.
    for (const tag of [
      'blocker_raised',
      'session_stopped',
      'run_paused',
      'waiting_for_input',
      'rate_limit_reached',
      'step_skipped',
      'service_degraded',
    ]) {
      expect(systemNotificationSeverity(tag)).toBe('warning');
    }
  });

  test('an unrecognised tag stays quiet rather than guessing', () => {
    for (const tag of [
      'task_completed',
      'snapshot_build_queued',
      'file_written',
      'branch_pushed',
      'something_nobody_has_classified_yet',
    ]) {
      expect(systemNotificationSeverity(tag)).toBe('action');
    }
  });

  test('keywords match whole words, so lookalikes do not trip the tone', () => {
    expect(systemNotificationSeverity('task_proceeded')).toBe('action'); // not "exceeded"
    expect(systemNotificationSeverity('mirror_synced')).toBe('action'); // not "error"
    expect(systemNotificationSeverity('terrorless_run')).toBe('action'); // not "error"
  });

  test('critical wins when a tag carries both signals', () => {
    expect(systemNotificationSeverity('retry_failed')).toBe('error');
  });
});

test('retains only valid private attachment references beside sandbox paths', () => {
  const ref = 'kortix-attachment://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333';
  const tag = (url: string) => `<file path="/workspace/uploads/a.png" mime="image/png" filename="a.png" attachment="${url}">file</file>`;
  expect(parseFileReferences(tag(ref)).files[0]).toMatchObject({ attachment: ref });
  expect(parseFileReferences(tag('https://other.test/private')).files[0]).not.toHaveProperty('attachment');
});

test('a pathological message cannot freeze the tab that renders it', () => {
  // Every viewer parses every user message. The regex this used took ~10 s on
  // this text — quadratic in it — so in a shared session one member's message
  // froze the tab of every member who opened it.
  const evil = `${'<file\t'.repeat(40_000)}<file${'\t'.repeat(200_000)}`;
  const started = performance.now();
  const parsed = parseFileReferences(evil);
  expect(performance.now() - started).toBeLessThan(100);
  expect(parsed.files).toEqual([]);
});

// ── Linear-time parsing ──────────────────────────────────────────────────────
//
// Every parser below used a lazy regex that re-scanned to the end of the text
// for each tag that never closed. The regexes are kept here ONLY as parity
// oracles: each parser must return exactly what its regex-based version did.

const unescapeAttr = (v: string) =>
  v.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const legacy = {
  projects(text: string) {
    let cleaned = text.replace(/<project_ref\b([\s\S]*?)\/>/g, '');
    cleaned = cleaned.replace(/\n*Referenced projects \([^)]*\):\n?/g, '').trim();
    return { cleanText: cleaned, projects: [] };
  },
  fileMentions(text: string) {
    const files: { path: string; name: string }[] = [];
    let cleaned = text.replace(/<file_ref\b([\s\S]*?)\/>/g, (_, attrs: string) => {
      const pick = (key: string) => {
        const m = attrs.match(new RegExp(`${key}="([^"]*?)"`));
        return m ? unescapeAttr(m[1]!) : undefined;
      };
      const path = pick('path');
      const name = pick('name') ?? path;
      if (path) files.push({ path, name: name || path });
      return '';
    });
    cleaned = cleaned.replace(/\n*Referenced files \([^)]*\):\n?/g, '').trim();
    return { cleanText: cleaned, files };
  },
  agentMentions(text: string) {
    const agents: { name: string }[] = [];
    let cleaned = text.replace(/<agent_ref\b([\s\S]*?)\/>/g, (_, attrs: string) => {
      const m = attrs.match(/name="([^"]*?)"/);
      const name = m ? unescapeAttr(m[1]!) : undefined;
      if (name) agents.push({ name });
      return '';
    });
    cleaned = cleaned.replace(/\n*Referenced agents \([^)]*\):\n?/g, '').trim();
    return { cleanText: cleaned, agents };
  },
  sessions(text: string) {
    const sessions: { id: string; title: string }[] = [];
    let cleaned = text.replace(/<session_ref\s+id="([^"]*?)"\s+title="([^"]*?)"\s*\/>/g, (_, id, title) => {
      sessions.push({ id, title });
      return '';
    });
    cleaned = cleaned
      .replace(/\n*Referenced sessions \(use the session_context tool to fetch details when needed\):\n?/g, '')
      .trim();
    return { cleanText: cleaned, sessions };
  },
  // The multi-quote regex version of parseReplyContexts (reply-context.ts).
  replies(text: string) {
    const quotes: string[] = [];
    const cleanText = text
      .replace(/<reply_context\b[^>]*>([\s\S]*?)<\/reply_context>\n?/g, (_full, rawBody: string) => {
        const index = quotes.length;
        quotes.push(rawBody.split('&lt;/reply_context&gt;').join('</reply_context>').trim());
        return quoteMarker(index);
      })
      .trim();
    return { cleanText, quotes };
  },
  notifications(text: string) {
    const notifications: { tag: string; label: string; fields: [string, string][]; body: string }[] = [];
    const cleanText = text
      .replace(/<([a-z][a-z0-9_-]*)>([\s\S]*?)<\/\1>/gi, (_full, tag: string, rawBody: string) => {
        const fields: [string, string][] = [];
        const bodyLines: string[] = [];
        let pastHeader = false;
        for (const line of rawBody.trim().split('\n')) {
          if (pastHeader) {
            bodyLines.push(line);
            continue;
          }
          if (line.trim() === '') {
            pastHeader = true;
            continue;
          }
          const m = line.match(/^([A-Za-z][\w\s]*?):\s*(.+)$/);
          if (m) {
            fields.push([m[1]!.trim(), m[2]!.trim()]);
          } else {
            pastHeader = true;
            bodyLines.push(line);
          }
        }
        notifications.push({
          tag: tag.toLowerCase(),
          label: tag.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
          fields,
          body: bodyLines.join('\n').trim(),
        });
        return '';
      })
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { cleanText, notifications };
  },
  trigger(rawText: string) {
    if (!rawText) return undefined;
    const match = rawText.match(/<trigger_event>\s*([\s\S]*?)\s*<\/trigger_event>/);
    if (!match) return undefined;
    try {
      const data = JSON.parse(match[1]!);
      const promptText = rawText.replace(/<trigger_event>[\s\S]*?<\/trigger_event>/, '').trim();
      return { data, prompt: promptText };
    } catch {
      return undefined;
    }
  },
};

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

/** 2000 strings of up to 20 tokens each, drawn from `tokens`. */
function samples(tokens: readonly string[]): string[] {
  const next = random(23);
  return Array.from({ length: 2000 }, () => {
    let text = '';
    const length = Math.floor(next() * 21);
    for (let i = 0; i < length; i++) text += tokens[Math.floor(next() * tokens.length)];
    return text;
  });
}

describe('each parser returns exactly what its regex returned', () => {
  test('parseProjectReferences', () => {
    for (const text of samples(['<project_ref', '<project_refs', ' name="a"', '/>', '\n', 'Referenced projects (', 'x', ')', '):', ' '])) {
      expect(parseProjectReferences(text)).toEqual(legacy.projects(text));
    }
  });

  test('parseFileMentionReferences', () => {
    for (const text of samples(['<file_ref', ' path="a.ts"', ' name="b"', ' path=""', '/>', '\n', 'Referenced files (', 'x', '):', '&amp;'])) {
      expect(parseFileMentionReferences(text)).toEqual(legacy.fileMentions(text));
    }
  });

  test('parseAgentMentionReferences', () => {
    for (const text of samples(['<agent_ref', ' name="build"', ' name=""', '/>', '\n', 'Referenced agents (', 'x', '):'])) {
      expect(parseAgentMentionReferences(text)).toEqual(legacy.agentMentions(text));
    }
  });

  test('parseSessionReferences', () => {
    const header = 'Referenced sessions (use the session_context tool to fetch details when needed):';
    for (const text of samples(['<session_ref id="a" title="b" />', '<session_ref', '\n', header, 'x', ' '])) {
      expect(parseSessionReferences(text)).toEqual(legacy.sessions(text));
    }
  });

  test('parseReplyContexts', () => {
    for (const text of samples(['<reply_context>', '</reply_context>', ' ', '\n', 'quoted', 'answer', '<reply_context',
      '<reply_context a="1">', '<reply_contextx>', '&lt;/reply_context&gt;'])) {
      expect(parseReplyContexts(text)).toEqual(legacy.replies(text));
    }
  });

  test('parseSystemNotifications', () => {
    for (const text of samples(['<task_failed>', '</task_failed>', '<TASK_FAILED>', '</Task_Failed>', '<a>', '</a>', '<b>',
      '</b>', 'Exit code: 1', 'Key', ':', ' ', '\t', '\r', '\u2028', '-', '\n', '\n\n', 'x', '<'])) {
      expect(parseSystemNotifications(text)).toEqual(legacy.notifications(text));
    }
  });

  test('parseTriggerEvent', () => {
    for (const text of samples(['<trigger_event>', '</trigger_event>', ' ', '\n', '{"trigger":"cron"}', '{', 'prompt', '"'])) {
      expect(parseTriggerEvent(text)).toEqual(legacy.trigger(text));
    }
  });
});

describe('no message can freeze the tab that parses it', () => {
  // Measured on the regexes with Bun: each took ~1 s or more on these inputs,
  // and each doubling of the text quadrupled the time.
  const within = (label: string, run: () => unknown) =>
    test(label, () => {
      const started = performance.now();
      run();
      expect(performance.now() - started).toBeLessThan(100);
    });

  within('16k <project_ref openers that never close', () => parseProjectReferences('<project_ref x>'.repeat(16_000)));
  within('20k <file_ref openers that never close', () => parseFileMentionReferences('<file_ref x>'.repeat(20_000)));
  within('18k <agent_ref openers that never close', () => parseAgentMentionReferences('<agent_ref x>'.repeat(18_000)));
  within('240k blank lines before a reference header', () => parseSessionReferences(`${'\n'.repeat(240_000)}x`));
  within('16k <reply_context> openers that never close', () => parseReplyContexts('<reply_context>'.repeat(16_000)));
  within('80k notification openers that never close', () => parseSystemNotifications('<a>'.repeat(80_000)));
  // `\s*(.+)$` split the whitespace every way once a `\r` kept `.` from the end.
  within('a notification field with 240k spaces before a \\r', () =>
    parseSystemNotifications(`<a>Key:${' '.repeat(240_000)}x\ry</a>`));
  // One opener and whitespace that never closes: the regex was CUBIC here —
  // 1,000 characters took ~180 ms, and 10,000 would take minutes.
  within('a <trigger_event> opener and 240k spaces', () => parseTriggerEvent(`<trigger_event>${' '.repeat(240_000)}x`));
  within('a trigger payload with a 240k-space string', () =>
    parseTriggerEvent(`<trigger_event>\n{"a":"${' '.repeat(240_000)}"}\n</trigger_event>`));
});
