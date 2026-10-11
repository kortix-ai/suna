import { describe, expect, test } from 'bun:test';

import { INBOX_NOTIFICATION_KINDS, type InboxNotification } from '@kortix/sdk';
import {
  KIND_LABEL,
  NOTIFICATION_INBOX_LIMIT,
  inboxOpenTarget,
  inboxRowDetail,
  inboxRowLabel,
  inboxRowTitle,
} from './inbox';

const NOW = Date.parse('2026-10-09T12:00:00.000Z');

function row(extra: Partial<InboxNotification> = {}): InboxNotification {
  return {
    id: 'note-1',
    kind: 'question',
    title: 'Fix the login page',
    body: 'Which branch?',
    project_id: 'proj-1',
    project_name: 'Website',
    session_id: 'sess-1',
    trigger_slug: null,
    actor_user_id: null,
    url: '/projects/proj-1/sessions/sess-1?notification=note-1',
    read: false,
    created_at: '2026-10-09T11:55:00.000Z',
    ...extra,
  };
}

describe('KIND_LABEL', () => {
  test("is the web app's word for each kind (notifications.kind.* in apps/web/translations/en.json)", () => {
    expect(KIND_LABEL).toEqual({
      turn_done: 'Turn finished',
      turn_error: 'Turn failed',
      question: 'Question',
      permission: 'Permission request',
      shared: 'Shared with you',
      automation_failed: 'Failure alert',
      automation_recovered: 'Recovery alert',
    });
  });

  test('covers every kind, each in sentence case, no two alike', () => {
    for (const kind of INBOX_NOTIFICATION_KINDS) {
      const label = KIND_LABEL[kind];
      expect(label[0]).toBe(label[0].toUpperCase());
      expect(label.slice(1)).toBe(label.slice(1).toLowerCase());
    }
    expect(new Set(Object.values(KIND_LABEL)).size).toBe(INBOX_NOTIFICATION_KINDS.length);
  });
});

describe('NOTIFICATION_INBOX_LIMIT', () => {
  test('is within the API page size (1 to 50)', () => {
    expect(NOTIFICATION_INBOX_LIMIT).toBeGreaterThanOrEqual(1);
    expect(NOTIFICATION_INBOX_LIMIT).toBeLessThanOrEqual(50);
  });
});

describe('inboxRowTitle', () => {
  test('the stored title', () => {
    expect(inboxRowTitle(row())).toBe('Fix the login page');
  });

  test('a session without a title reads as the untitled session label', () => {
    expect(inboxRowTitle(row({ title: '  ' }))).toBe('New session');
  });

  test('an automation without a title reads as its trigger', () => {
    expect(
      inboxRowTitle(row({ kind: 'automation_failed', title: '', session_id: null, trigger_slug: 'nightly-report' }))
    ).toBe('nightly-report');
  });
});

describe('inboxRowDetail', () => {
  test('the kind, then the project', () => {
    expect(inboxRowDetail(row())).toBe('Question · Website');
  });

  test('the kind alone when the project has no name', () => {
    expect(inboxRowDetail(row({ project_name: null }))).toBe('Question');
  });

  test('a kind this app does not know yet reads as a notification', () => {
    expect(inboxRowDetail(row({ kind: 'waiting' as InboxNotification['kind'] }))).toBe('Notification · Website');
  });
});

describe('inboxRowLabel', () => {
  test('kind, title, project, spoken time, and unread', () => {
    expect(inboxRowLabel(row(), NOW)).toBe('Question, Fix the login page, Website, 5 minutes ago, unread');
  });

  test('a read row does not say unread', () => {
    expect(inboxRowLabel(row({ read: true, project_name: null }), NOW)).toBe('Question, Fix the login page, 5 minutes ago');
  });
});

describe('inboxOpenTarget', () => {
  test('a session row opens its session in its project', () => {
    expect(inboxOpenTarget(row())).toEqual({ projectId: 'proj-1', sessionId: 'sess-1' });
  });

  test('an automation alert opens its project', () => {
    expect(inboxOpenTarget(row({ kind: 'automation_failed', session_id: null, trigger_slug: 'nightly-report' }))).toEqual({
      projectId: 'proj-1',
      sessionId: null,
    });
  });

  test('a row without a project opens nothing', () => {
    expect(inboxOpenTarget(row({ project_id: null }))).toBeNull();
  });
});
