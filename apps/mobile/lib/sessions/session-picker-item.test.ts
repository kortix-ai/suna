import { describe, expect, test } from 'bun:test';
import type { ProjectSession } from '@kortix/sdk';
import { toSessionPickerItems } from './session-picker-item';

// This projection is the join between "what the API returns" and "what the
// command palette, the @-mention list and the tabs overview render". Three
// surfaces read it, so the ordering and the title fallbacks are asserted here
// once rather than assumed three times.

function row(over: Partial<ProjectSession> = {}): ProjectSession {
  return {
    session_id: 'ses-1',
    account_id: 'acc-1',
    project_id: 'proj-1',
    branch_name: 'kortix/session-1',
    base_ref: 'main',
    sandbox_provider: 'platinum',
    sandbox_id: 'sbx-1',
    sandbox_url: null,
    opencode_session_id: null,
    name: null,
    custom_name: null,
    agent_name: null,
    status: 'stopped',
    error: null,
    metadata: {},
    opencode_sessions: [],
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    ...over,
  } as ProjectSession;
}

describe('toSessionPickerItems', () => {
  test('orders newest first, so every surface agrees on recency', () => {
    const items = toSessionPickerItems([
      row({ session_id: 'old', updated_at: '2026-09-01T00:00:00.000Z' }),
      row({ session_id: 'newest', updated_at: '2026-09-22T12:00:00.000Z' }),
      row({ session_id: 'middle', updated_at: '2026-09-10T00:00:00.000Z' }),
    ]);
    expect(items.map((i) => i.id)).toEqual(['newest', 'middle', 'old']);
  });

  test('falls back to the branch name when a session has not been named', () => {
    const [item] = toSessionPickerItems([row({ name: null, branch_name: 'kortix/fix-login' })]);
    expect(item?.title).toBe('kortix/fix-login');
  });

  test('prefers the resolved name over the branch', () => {
    const [item] = toSessionPickerItems([
      row({ name: 'Fix the login redirect', branch_name: 'kortix/fix-login' }),
    ]);
    expect(item?.title).toBe('Fix the login redirect');
  });

  test('never renders an empty label', () => {
    const [item] = toSessionPickerItems([row({ name: null, branch_name: '' })]);
    expect(item?.title).toBe('New session');
  });

  test('carries the runtime id, which is how a transcript is found', () => {
    // The SDK's transcript store is keyed by the OpenCode session id, not the
    // Kortix one. A surface that wants this session's messages has no other way
    // to get from a tab to its transcript.
    const [item] = toSessionPickerItems([row({ opencode_session_id: 'ses_abc123' })]);
    expect(item?.runtimeSessionId).toBe('ses_abc123');
  });

  test('reports a null runtime id for a session that has never started', () => {
    // A brand-new or never-run session has no OpenCode root yet. That is not an
    // error state — it means "no transcript to look up", and callers must be
    // able to tell it apart from a missing row.
    const [item] = toSessionPickerItems([row({ opencode_session_id: null })]);
    expect(item?.runtimeSessionId).toBeNull();
  });

  test('a session whose timestamp is unparseable sorts last instead of throwing', () => {
    const items = toSessionPickerItems([
      row({ session_id: 'broken', updated_at: 'not-a-date' }),
      row({ session_id: 'fine', updated_at: '2026-09-10T00:00:00.000Z' }),
    ]);
    expect(items.map((i) => i.id)).toEqual(['fine', 'broken']);
    expect(items[1]?.updatedAt).toBe(0);
  });

  test('is empty for an empty list rather than undefined', () => {
    expect(toSessionPickerItems([])).toEqual([]);
  });
});
