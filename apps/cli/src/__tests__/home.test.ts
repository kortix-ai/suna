import { describe, expect, test } from 'bun:test';

import type { ProjectSession } from '../api/types.ts';
import { buildConnectPickerItems } from '../commands/home.ts';

function session(overrides: Partial<ProjectSession>): ProjectSession {
  return {
    session_id: '00000000-0000-0000-0000-000000000000',
    account_id: 'acct',
    project_id: 'proj',
    branch_name: 'branch',
    base_ref: 'main',
    sandbox_provider: 'daytona',
    sandbox_id: 'sb',
    sandbox_url: null,
    opencode_session_id: null,
    name: null,
    custom_name: null,
    agent_name: 'default',
    status: 'running',
    error: null,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  } as ProjectSession;
}

describe('buildConnectPickerItems', () => {
  test('orders running (most recent first), then booting, then dormant, then the new row', () => {
    const items = buildConnectPickerItems([
      session({ session_id: 'aaaa1111-old-run', updated_at: '2026-08-01T00:00:00Z' }),
      session({ session_id: 'bbbb2222-stopped', status: 'stopped' }),
      session({ session_id: 'cccc3333-new-run', updated_at: '2026-08-02T00:00:00Z' }),
      session({ session_id: 'dddd4444-provisioning', status: 'provisioning' }),
      session({ session_id: 'eeee5555-failed', status: 'failed' }),
    ]);

    expect(items.map((i) => (i.value === 'new' ? 'new' : i.value.session_id))).toEqual([
      'cccc3333-new-run',
      'aaaa1111-old-run',
      'dddd4444-provisioning',
      'bbbb2222-stopped',
      'eeee5555-failed',
      'new',
    ]);
  });

  test('labels dormant and booting rows with what connecting will do', () => {
    const items = buildConnectPickerItems([
      session({ session_id: 'aaaa1111-x', status: 'stopped' }),
      session({ session_id: 'bbbb2222-x', status: 'provisioning' }),
    ]);

    expect(items[0]!.sublabel).toContain('waits for boot');
    expect(items[1]!.sublabel).toContain('starts it first');
  });

  test('caps the dormant tail at 15 but always keeps the new-session row', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      session({ session_id: `session-${i}`, status: 'stopped' }),
    );

    const items = buildConnectPickerItems(many);

    expect(items).toHaveLength(16);
    expect(items.at(-1)!.value).toBe('new');
  });

  test('with no sessions returns only the new-session row', () => {
    const items = buildConnectPickerItems([]);

    expect(items).toHaveLength(1);
    expect(items[0]!.value).toBe('new');
  });
});
