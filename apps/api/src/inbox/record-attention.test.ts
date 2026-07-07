import { describe, expect, test } from 'bun:test';

import {
  attentionDedupKey,
  inboxTitle,
  isBackgroundSource,
  sessionSourceKind,
} from './record-attention';

describe('isBackgroundSource', () => {
  test('triggers and inbound channels are background automations', () => {
    for (const s of [
      'trigger:webhook',
      'trigger:cron',
      'trigger:manual',
      'slack',
      'email',
      'telegram',
      'meet',
    ]) {
      expect(isBackgroundSource(s)).toBe(true);
    }
  });

  test('foreground and internal sources are not background', () => {
    for (const s of ['ui', 'mobile', 'cli', 'admin', 'system:sandbox-build-fix']) {
      expect(isBackgroundSource(s)).toBe(false);
    }
  });

  test('non-strings are never background', () => {
    expect(isBackgroundSource(undefined)).toBe(false);
    expect(isBackgroundSource(null)).toBe(false);
    expect(isBackgroundSource(42)).toBe(false);
  });
});

describe('sessionSourceKind', () => {
  test('maps cron to schedule and webhook/manual to webhook', () => {
    expect(sessionSourceKind('trigger:cron')).toBe('schedule');
    expect(sessionSourceKind('trigger:webhook')).toBe('webhook');
    expect(sessionSourceKind('trigger:manual')).toBe('webhook');
  });

  test('passes channel kinds through', () => {
    expect(sessionSourceKind('slack')).toBe('slack');
    expect(sessionSourceKind('telegram')).toBe('telegram');
    expect(sessionSourceKind('email')).toBe('email');
    expect(sessionSourceKind('meet')).toBe('meet');
  });

  test('returns null for unmapped sources', () => {
    expect(sessionSourceKind('ui')).toBeNull();
    expect(sessionSourceKind(undefined)).toBeNull();
  });
});

describe('inboxTitle', () => {
  const base = { branchName: 'kortix/run-1', sessionId: 'sess_123' };

  test('custom_name wins over auto name', () => {
    expect(
      inboxTitle({ ...base, metadata: { custom_name: 'Nightly backup', name: 'auto title' } }),
    ).toBe('Nightly backup');
  });

  test('falls back to auto name, then branch, then id', () => {
    expect(inboxTitle({ ...base, metadata: { name: 'Fix the flaky test' } })).toBe(
      'Fix the flaky test',
    );
    expect(inboxTitle({ ...base, metadata: {} })).toBe('kortix/run-1');
    expect(inboxTitle({ branchName: '', sessionId: 'sess_123', metadata: null })).toBe('sess_123');
  });

  test('ignores blank/whitespace names', () => {
    expect(inboxTitle({ ...base, metadata: { custom_name: '   ', name: '' } })).toBe('kortix/run-1');
  });

  test('prefers the trigger slug over the auto name and branch', () => {
    expect(
      inboxTitle({ ...base, metadata: { trigger_slug: 'github-pr-review', name: 'auto' } }),
    ).toBe('github-pr-review');
    expect(
      inboxTitle({ ...base, metadata: { custom_name: 'Mine', trigger_slug: 'nightly' } }),
    ).toBe('Mine');
  });
});

describe('attentionDedupKey', () => {
  test('collapses within the same minute, differs across minutes', () => {
    const t0 = 1_800_000_000_000;
    expect(attentionDedupKey('run_completed', 'sess_1', t0)).toBe(
      attentionDedupKey('run_completed', 'sess_1', t0 + 59_000),
    );
    expect(attentionDedupKey('run_completed', 'sess_1', t0)).not.toBe(
      attentionDedupKey('run_completed', 'sess_1', t0 + 61_000),
    );
  });

  test('kind and session are part of the key', () => {
    const t0 = 1_800_000_000_000;
    expect(attentionDedupKey('run_completed', 'sess_1', t0)).not.toBe(
      attentionDedupKey('run_failed', 'sess_1', t0),
    );
    expect(attentionDedupKey('run_completed', 'sess_1', t0)).not.toBe(
      attentionDedupKey('run_completed', 'sess_2', t0),
    );
  });
});
