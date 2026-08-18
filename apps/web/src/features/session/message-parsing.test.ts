import { describe, expect, test } from 'bun:test';

import {
  parseFileReferences,
  parseSystemNotifications,
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

  test('reads a pending id off an in-flight ref', () => {
    const { files } = parseFileReferences(
      '<file path="" mime="image/png" filename="image.png" pending="upl_1">\nx\n</file>',
    );

    expect(files[0].pending).toBe('upl_1');
    expect(files[0].path).toBe('');
  });

  test('a tag with no path and no filename is left in the text', () => {
    // Attributes are read by name now. A `<file>` block that carries neither is
    // not a file reference, and swallowing it would delete message content.
    const input = '<file foo="bar">\nnot a ref\n</file>';
    expect(parseFileReferences(input)).toEqual({ cleanText: input, files: [] });
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
