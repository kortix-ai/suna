import { describe, expect, test } from 'bun:test';
import {
  parseTriggerSessionAccess,
  triggerSessionAccessToVisibility,
} from '../projects/trigger-session-access-policy';

const MEMBER = '11111111-2222-4333-8444-555555555555';
const GROUP = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('trigger session access policy', () => {
  test('deduplicates selected members and groups', () => {
    expect(
      parseTriggerSessionAccess({
        mode: 'members',
        memberIds: [MEMBER, MEMBER],
        groupIds: [GROUP, GROUP],
      }),
    ).toEqual({
      ok: true,
      access: { mode: 'members', memberIds: [MEMBER], groupIds: [GROUP] },
    });
  });

  test('normalizes an empty selected policy to private', () => {
    expect(
      parseTriggerSessionAccess({
        mode: 'members',
        memberIds: [],
        groupIds: [],
      }),
    ).toEqual({
      ok: true,
      access: { mode: 'private', memberIds: [], groupIds: [] },
    });
  });

  test('removes irrelevant principals from private and project modes', () => {
    expect(
      parseTriggerSessionAccess({
        mode: 'private',
        memberIds: [MEMBER],
        groupIds: [GROUP],
      }),
    ).toEqual({
      ok: true,
      access: { mode: 'private', memberIds: [], groupIds: [] },
    });
    expect(
      parseTriggerSessionAccess({
        mode: 'project',
        memberIds: [MEMBER],
        groupIds: [GROUP],
      }),
    ).toEqual({
      ok: true,
      access: { mode: 'project', memberIds: [], groupIds: [] },
    });
  });

  test('rejects unknown modes, malformed arrays, and invalid principal ids', () => {
    expect(parseTriggerSessionAccess({ mode: 'account' }).ok).toBe(false);
    expect(parseTriggerSessionAccess({ mode: 'members', memberIds: 'x' }).ok).toBe(false);
    expect(
      parseTriggerSessionAccess({
        mode: 'members',
        memberIds: ['not-a-uuid'],
        groupIds: [],
      }).ok,
    ).toBe(false);
  });

  test('maps public policies onto persisted session visibility', () => {
    expect(
      triggerSessionAccessToVisibility({
        mode: 'private',
        memberIds: [],
        groupIds: [],
      }),
    ).toBe('private');
    expect(
      triggerSessionAccessToVisibility({
        mode: 'project',
        memberIds: [],
        groupIds: [],
      }),
    ).toBe('project');
    expect(
      triggerSessionAccessToVisibility({
        mode: 'members',
        memberIds: [MEMBER],
        groupIds: [],
      }),
    ).toBe('restricted');
  });
});
