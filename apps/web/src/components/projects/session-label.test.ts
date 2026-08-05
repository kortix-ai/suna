import { describe, expect, test } from 'bun:test';

import type { ProjectSession } from '@kortix/sdk';
import {
  availableSessionFilterOptions,
  SESSION_DISPLAY_STATUS_LABELS,
  sessionDisplayStatus,
  type SessionDisplayStatus,
} from './session-label';

function makeSession(overrides: Partial<ProjectSession> = {}): ProjectSession {
  return {
    session_id: 's1',
    project_id: 'p1',
    status: 'running',
    created_at: '2026-01-01T00:00:00.000Z',
    custom_name: null,
    name: null,
    branch_name: null,
    metadata: null,
    ...overrides,
  } as unknown as ProjectSession;
}

const myChat = () => makeSession({ is_owner: true });
const sharedChat = () => makeSession({ is_owner: false });
const slack = () => makeSession({ metadata: { source: 'slack' } });
const email = () => makeSession({ metadata: { source: 'email' } });
const scheduled = () =>
  makeSession({ metadata: { trigger_source: 'cron', trigger_type: 'cron', trigger_slug: 'daily' } });
const telegram = () => makeSession({ metadata: { source: 'telegram' } });

describe('availableSessionFilterOptions', () => {
  test('one source only: no options, because every filter equals "All"', () => {
    expect(availableSessionFilterOptions([myChat(), myChat()])).toEqual([]);
    expect(availableSessionFilterOptions([sharedChat()])).toEqual([]);
    expect(availableSessionFilterOptions([slack(), slack()])).toEqual([]);
    expect(availableSessionFilterOptions([email()])).toEqual([]);
    expect(availableSessionFilterOptions([scheduled()])).toEqual([]);
  });

  test('no sessions: no options', () => {
    expect(availableSessionFilterOptions([])).toEqual([]);
  });

  test('two sources: "All" plus exactly the present ones, in canonical order', () => {
    const options = availableSessionFilterOptions([slack(), myChat(), email()]);

    expect(options.map((option) => option.value)).toEqual(['all', 'mine', 'slack', 'email']);
  });

  test('a source with zero sessions never gets a row', () => {
    const options = availableSessionFilterOptions([myChat(), sharedChat()]);

    expect(options.map((option) => option.value)).toEqual(['all', 'mine', 'shared']);
    expect(options.every((option) => option.count > 0)).toBe(true);
  });

  test('counts match the sessions each filter selects', () => {
    const sessions = [myChat(), myChat(), sharedChat(), slack(), scheduled(), scheduled()];

    const counts = Object.fromEntries(
      availableSessionFilterOptions(sessions).map((option) => [option.value, option.count]),
    );

    expect(counts).toEqual({ all: 6, mine: 2, shared: 1, slack: 1, schedule: 2 });
  });

  test('"All" counts kinds no filter covers, so the total never lies', () => {
    const options = availableSessionFilterOptions([myChat(), slack(), telegram()]);

    expect(options[0]).toEqual({ value: 'all', label: 'All', count: 3 });
    expect(options.map((option) => option.value)).not.toContain('telegram');
  });

  test('telegram-only projects get no menu: it is one source with no filter', () => {
    expect(availableSessionFilterOptions([telegram(), telegram()])).toEqual([]);
  });
});

describe('sessionDisplayStatus', () => {
  test('maps queued to starting', () => {
    // @ts-expect-error - testing with a status value
    expect(sessionDisplayStatus(makeSession({ status: 'queued' as any }))).toBe('starting');
  });

  test('maps branching to starting', () => {
    // @ts-expect-error - testing with a status value
    expect(sessionDisplayStatus(makeSession({ status: 'branching' as any }))).toBe('starting');
  });

  test('maps provisioning to starting', () => {
    // @ts-expect-error - testing with a status value
    expect(sessionDisplayStatus(makeSession({ status: 'provisioning' as any }))).toBe('starting');
  });

  test('maps running to running', () => {
    expect(sessionDisplayStatus(makeSession({ status: 'running' }))).toBe('running');
  });

  test('maps completed to done', () => {
    // @ts-expect-error - testing with a status value
    expect(sessionDisplayStatus(makeSession({ status: 'completed' as any }))).toBe('done');
  });

  test('maps stopped to stopped', () => {
    // @ts-expect-error - testing with a status value
    expect(sessionDisplayStatus(makeSession({ status: 'stopped' as any }))).toBe('stopped');
  });

  test('maps failed to failed', () => {
    // @ts-expect-error - testing with a status value
    expect(sessionDisplayStatus(makeSession({ status: 'failed' as any }))).toBe('failed');
  });

  test('defaults reviewCount to 0 so a running session stays running', () => {
    expect(sessionDisplayStatus(makeSession({ status: 'running' }))).toBe('running');
  });

  test('a pending review overrides every lifecycle status', () => {
    const statuses: any[] = ['queued', 'branching', 'provisioning', 'running', 'completed', 'stopped', 'failed'];
    for (const status of statuses) {
      expect(sessionDisplayStatus(makeSession({ status }), 1)).toBe('needs-you');
    }
  });

  test('a zero review count does not override', () => {
    // @ts-expect-error - testing with a status value
    expect(sessionDisplayStatus(makeSession({ status: 'completed' as any }), 0)).toBe('done');
  });

  test('every display status has a label', () => {
    const all = [
      'needs-you', 'starting', 'running', 'done', 'stopped', 'failed',
    ] as const;
    for (const value of all) {
      expect(SESSION_DISPLAY_STATUS_LABELS[value]).toBeTruthy();
    }
  });

  test('labels never say "Active" — the data cannot support it', () => {
    expect(Object.values(SESSION_DISPLAY_STATUS_LABELS)).not.toContain('Active');
  });
});
