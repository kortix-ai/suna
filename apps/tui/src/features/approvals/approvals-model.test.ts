import { describe, expect, test } from 'bun:test';

import type { ReviewItem } from '@kortix/sdk';

import {
  decisionOptions,
  detailLines,
  groupRows,
  promptFor,
  rightText,
  toApprovalRow,
  verbsFor,
  webReviewUrl,
} from './approvals-model.ts';
import { doneText } from './approvals-screen.tsx';

const NOW = new Date(2026, 8, 17, 12, 0, 0).getTime();
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

function base(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ri-1',
    title: 'Send the quarterly email',
    summary: 'From a running session',
    risk: 'medium',
    status: 'needs_you',
    source: 'agent',
    agent: 'ops',
    createdAt: iso(NOW - 3 * 60_000),
    sessionId: 's-1',
    ...overrides,
  };
}

const approval = (overrides: Record<string, unknown> = {}, action: Record<string, unknown> = {}) =>
  ({
    ...base({ id: 'call:exec-1', kind: 'approval', ...overrides }),
    detail: {
      actions: [
        {
          id: 'a1',
          title: 'Send email',
          connector: 'gmail',
          connectorName: 'Gmail',
          action: 'send_email',
          consequence: 'Sends one email to 40 people.',
          risk: 'high',
          icon: 'email',
          argsPreview: [
            { key: 'to', value: 'team@example.test' },
            { key: 'subject', value: 'Q3 numbers' },
          ],
          policySource: 'approve',
          ...action,
        },
      ],
    },
  }) as unknown as ReviewItem;

const output = (overrides: Record<string, unknown> = {}) =>
  ({
    ...base({ kind: 'output', ...overrides }),
    detail: {
      artifactKind: 'document',
      artifactLabel: 'Q3 report',
      note: 'Draft for review.',
      files: [{ path: '/Company/q3.md' }],
    },
  }) as unknown as ReviewItem;

const decision = (overrides: Record<string, unknown> = {}) =>
  ({
    ...base({ id: 'ri-2', kind: 'decision', ...overrides }),
    detail: {
      question: 'Which bank?',
      context: 'We need an account by Friday.',
      options: [
        { id: 'o1', label: 'Mercury' },
        { id: 'o2', label: 'Brex', recommended: true, description: 'Lower fees.' },
      ],
    },
  }) as unknown as ReviewItem;

const change = (overrides: Record<string, unknown> = {}) =>
  ({
    ...base({ id: 'cr:cr-9', kind: 'change', ...overrides }),
    detail: {
      whatChanged: ['Tighten boot path'],
      impact: 'Faster starts.',
      verification: [{ label: 'Tests pass', tone: 'success' }],
      conflicts: [],
      advanced: {
        headRef: 'session/a',
        baseRef: 'main',
        headSha: 'a',
        baseSha: 'b',
        additions: 3,
        deletions: 1,
        files: [{ path: 'a.ts', status: 'modified', additions: 3, deletions: 1 }],
        mergeMode: 'squash',
      },
    },
  }) as unknown as ReviewItem;

describe('verbsFor', () => {
  test('a connector call is approve or reject only', () => {
    expect(verbsFor(approval(), NOW)).toEqual(['approve', 'reject']);
  });

  test('a call the viewer cannot resolve has no verbs', () => {
    expect(verbsFor(approval({}, { canResolve: false }), NOW)).toEqual([]);
    expect(verbsFor(approval({}, { previewAuthorized: false }), NOW)).toEqual([]);
  });

  test('an expired call has no verbs', () => {
    expect(verbsFor(approval({ expiresAt: iso(NOW - HOUR) }), NOW)).toEqual([]);
    expect(verbsFor(approval({ expiresAt: iso(NOW + HOUR) }), NOW)).toEqual(['approve', 'reject']);
  });

  test('a decided item has no verbs', () => {
    expect(verbsFor(output({ status: 'approved' }), NOW)).toEqual([]);
    expect(verbsFor(output({ status: 'waiting' }), NOW)).toEqual([]);
  });

  test('a change request can be merged, closed or sent back, not dismissed', () => {
    expect(verbsFor(change(), NOW)).toEqual(['approve', 'reject', 'changes']);
  });

  test('an output has all four; a decision answers or dismisses', () => {
    expect(verbsFor(output(), NOW)).toEqual(['approve', 'changes', 'reject', 'dismiss']);
    expect(verbsFor(decision(), NOW)).toEqual(['answer', 'dismiss']);
  });
});

describe('promptFor', () => {
  test('approve and dismiss confirm; the change request approve says merge', () => {
    expect(promptFor('approve', approval())).toEqual({
      kind: 'confirm',
      question: 'Approve "Send the quarterly email"?',
    });
    expect(promptFor('approve', change())).toMatchObject({
      question: 'Merge "Send the quarterly email"?',
    });
    expect(promptFor('dismiss', output()).kind).toBe('confirm');
  });

  test('reject takes an optional reason; changes and answer need text', () => {
    expect(promptFor('reject', output())).toMatchObject({ kind: 'input', required: false });
    expect(promptFor('changes', output())).toMatchObject({ kind: 'input', required: true });
    expect(promptFor('answer', decision())).toMatchObject({ kind: 'input', required: true });
  });
});

describe('rows', () => {
  test('a high-risk item that needs you reads as a danger glyph', () => {
    const row = toApprovalRow(approval({ risk: 'high' }));
    expect(row).toMatchObject({
      glyph: '!',
      tone: 'bad',
      kind: 'approval',
      status: 'Needs you',
      sessionId: 's-1',
    });
  });

  test('a decided item reads as a check or a cross', () => {
    expect(toApprovalRow(output({ status: 'approved' })).glyph).toBe('✓');
    expect(toApprovalRow(output({ status: 'rejected' })).glyph).toBe('×');
  });

  test('groupRows orders approvals, outputs, decisions, changes and keeps the server order inside a kind', () => {
    const rows = [
      toApprovalRow(change({ id: 'cr:1' })),
      toApprovalRow(decision({ id: 'd1' })),
      toApprovalRow(output({ id: 'o1' })),
      toApprovalRow(approval({ id: 'call:a1' })),
      toApprovalRow(output({ id: 'o2' })),
    ];
    expect(groupRows(rows).map((r) => r.id)).toEqual(['call:a1', 'o1', 'o2', 'd1', 'cr:1']);
  });

  test('the right column shows risk only when it is medium or high', () => {
    expect(rightText(toApprovalRow(approval()), NOW)).toBe('medium · ops · 3m');
    expect(rightText(toApprovalRow(output({ risk: 'low' })), NOW)).toBe('ops · 3m');
  });
});

describe('detailLines', () => {
  test('an approval prints the consequence and every argument', () => {
    const text = detailLines(approval(), 60, NOW).map((l) => l.text);
    expect(text).toContain('Send email');
    expect(text).toContain('Sends one email to 40 people.');
    expect(text).toContain('  to: team@example.test');
    expect(text).toContain('  subject: Q3 numbers');
  });

  test('hidden arguments are named, not blank', () => {
    const lines = detailLines(
      approval({}, { previewAuthorized: false, canResolve: false }),
      60,
      NOW,
    );
    expect(lines.some((l) => l.text.startsWith('You may not see the arguments'))).toBe(true);
    expect(lines.some((l) => l.text.startsWith('Only a project manager'))).toBe(true);
  });

  test('a decision numbers its options with the recommended one first', () => {
    expect(decisionOptions(decision()).map((o) => o.label)).toEqual(['Brex', 'Mercury']);
    const text = detailLines(decision(), 60, NOW).map((l) => l.text);
    expect(text).toContain('1. Brex  (recommended)');
    expect(text).toContain('2. Mercury');
  });

  test('an output lists its files; a change lists what changed', () => {
    expect(detailLines(output(), 60, NOW).map((l) => l.text)).toContain('  /Company/q3.md');
    const change_ = detailLines(change(), 60, NOW).map((l) => l.text);
    expect(change_).toContain('- Tighten boot path');
    expect(change_).toContain('session/a → main · +3 −1');
  });

  test('every line fits the width', () => {
    for (const item of [approval(), output(), decision(), change()]) {
      for (const line of detailLines(item, 30, NOW))
        expect(line.text.length).toBeLessThanOrEqual(32);
    }
  });
});

describe('helpers', () => {
  test('doneText names what the verdict did to each kind of id', () => {
    expect(doneText('approve', 'cr:1')).toBe('Change merged.');
    expect(doneText('reject', 'cr:1')).toBe('Change closed.');
    expect(doneText('reject', 'call:1')).toBe('Denied.');
    expect(doneText('reject', 'ri-1')).toBe('Rejected.');
  });

  test('webReviewUrl encodes the id', () => {
    expect(webReviewUrl('https://dev.kortix.com/', 'p1', 'call:abc')).toBe(
      'https://dev.kortix.com/projects/p1/review?id=call%3Aabc',
    );
  });
});
