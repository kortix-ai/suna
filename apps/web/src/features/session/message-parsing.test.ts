import { describe, expect, test } from 'bun:test';

import {
  parseFileReferences,
  parseReplyContexts,
  parseSystemNotifications,
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

describe('parseReplyContexts / serializeReplyContext / stripReplyContexts / splitAtQuoteMarkers (COR-117)', () => {
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
