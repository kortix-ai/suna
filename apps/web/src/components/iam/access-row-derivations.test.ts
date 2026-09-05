import { describe, expect, test } from 'bun:test';

import { accessVia, agentsMetaPart } from './access-projects-tab';

/**
 * Replaces `member-access-label.test.ts`, which covered the deleted
 * `memberAccessLabel`. The ROLE half of that helper is now
 * `roleValueLabel('project', …)` in `features/workspace/shared/access`
 * (covered by `role-select.test.ts`); what is left here — and still this
 * file's own logic — is the row's meta line: the "via …" attribution and the
 * "Agents: …" summary that replaced the popover columns.
 */

type ViaInput = Parameters<typeof accessVia>[0];

function member(overrides: Partial<ViaInput> = {}): ViaInput {
  return {
    effective_project_role: 'manager',
    effective_source: 'direct',
    ...overrides,
  } as ViaInput;
}

describe('accessVia', () => {
  test('a plain direct grant needs no attribution line', () => {
    expect(accessVia(member())).toBeNull();
  });

  test('an owner/admin row says the access comes from the account role', () => {
    expect(
      accessVia(member({ effective_project_role: 'manager', effective_source: 'implicit' })),
    ).toBe('via account admin');
  });

  test('a single group source names the group', () => {
    expect(
      accessVia(
        member({
          effective_source: 'group',
          group_sources: [{ group_id: 'g1', group_name: 'Engineering', role: 'manager' }],
        }),
      ),
    ).toBe('via Engineering');
  });

  test('extra group sources collapse into "+N more"', () => {
    expect(
      accessVia(
        member({
          effective_source: 'group',
          group_sources: [
            { group_id: 'g1', group_name: 'Engineering', role: 'manager' },
            { group_id: 'g2', group_name: 'Design', role: 'member' },
            { group_id: 'g3', group_name: 'Ops', role: 'member' },
          ],
        }),
      ),
    ).toBe('via Engineering +2 more');
  });

  test('a group source with no resolved name falls back to no line', () => {
    expect(
      accessVia(member({ effective_source: 'group', group_sources: [] })),
    ).toBeNull();
  });

  test('no effective role reads "no access", not an empty meta', () => {
    expect(accessVia(member({ effective_project_role: null, effective_source: null }))).toBe(
      'no access',
    );
  });
});

describe('agentsMetaPart', () => {
  test('no resource grants means every agent in the project', () => {
    expect(agentsMetaPart(0, 5)).toBe('Agents: all');
    // A member with no grant rows can use NO agent — agents are closed by
    // default and only the manager tier bypasses that.
    expect(agentsMetaPart(0, 5, false)).toBe('Agents: none');
  });

  test('a subset reads as a fraction of the project roster', () => {
    expect(agentsMetaPart(3, 5)).toBe('Agents: 3 of 5');
  });

  test('without a readable roster it degrades to the bare count, never "of undefined"', () => {
    expect(agentsMetaPart(3, undefined)).toBe('Agents: 3');
  });
});
