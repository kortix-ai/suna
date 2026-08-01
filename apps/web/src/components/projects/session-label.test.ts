import { describe, expect, test } from 'bun:test';

import type { ProjectSession } from '@kortix/sdk';
import { availableSessionFilterOptions } from './session-label';

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
