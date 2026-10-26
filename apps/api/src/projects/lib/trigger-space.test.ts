import { describe, expect, test } from 'bun:test';
import type { TriggerSessionAccess } from '@kortix/api-contract';

import { PRIVATE_TRIGGER_SESSION_ACCESS } from '../trigger-session-access-policy';
import {
  PROJECT_TRIGGER_SESSION_ACCESS,
  decideTriggerSpacePatch,
  defaultTriggerCreateAccess,
  triggerRunSpace,
} from './trigger-space';

type Space = Parameters<typeof triggerRunSpace>[0] & {};
const channel = { spaceId: 'sp-ops', kind: 'channel', dmAgentName: null, dmUserId: null } as unknown as Space;
const other = { spaceId: 'sp-launch', kind: 'channel', dmAgentName: null, dmUserId: null } as unknown as Space;
const dm = { spaceId: 'sp-dm', kind: 'dm', dmAgentName: 'researcher', dmUserId: 'u1' } as unknown as Space;
const members: TriggerSessionAccess = { mode: 'members', memberIds: ['u2'], groupIds: [] };

describe('triggerRunSpace: the space a trigger run is filed in', () => {
  test('a channel trigger runs in its channel, whatever its agent', () => {
    expect(triggerRunSpace(channel, 'writer')).toBe(channel);
  });

  test('a DM trigger runs in the DM only with the DM agent; a manifest edit that changed the agent files it in the default channel', () => {
    expect(triggerRunSpace(dm, 'researcher')).toBe(dm);
    expect(triggerRunSpace(dm, 'writer')).toBeNull();
    expect(triggerRunSpace(dm, undefined)).toBeNull();
  });

  test('no live space: the default channel', () => {
    expect(triggerRunSpace(null, 'researcher')).toBeNull();
  });
});

describe('decideTriggerSpacePatch: a PATCH that names a space', () => {
  test('a sharing save with the stored space_id re-shares earlier threads: the space did not change', () => {
    const out = decideTriggerSpacePatch(channel, channel, members);
    expect(out).toEqual({ nextSpace: undefined, space: channel, access: members, propagate: true });
  });

  test('a sharing save with space_id null on a trigger with no space re-shares earlier threads', () => {
    expect(decideTriggerSpacePatch(null, null, members).propagate).toBe(true);
  });

  test('a move to another channel applies to later runs only; with no policy they become project-visible', () => {
    expect(decideTriggerSpacePatch(channel, other, members)).toEqual({ nextSpace: other, space: other, access: members, propagate: false });
    expect(decideTriggerSpacePatch(channel, other, null).access).toEqual(PROJECT_TRIGGER_SESSION_ACCESS);
  });

  test('a DM trigger stays shared with the DM member only and never re-shares', () => {
    const out = decideTriggerSpacePatch(dm, undefined, members);
    expect(out.access).toEqual({ mode: 'members', memberIds: ['u1'], groupIds: [] });
    expect(out.propagate).toBe(false);
  });

  test('no space named and no sharing save: nothing changes', () => {
    expect(decideTriggerSpacePatch(channel, undefined, null)).toEqual({ nextSpace: undefined, space: channel, access: null, propagate: false });
  });
});

describe('defaultTriggerCreateAccess: a create\'s sharing', () => {
  test('a DM trigger is shared with the DM member only, whatever the body asks', () => {
    const dmOnly: TriggerSessionAccess = { mode: 'members', memberIds: ['u1'], groupIds: [] };
    expect(defaultTriggerCreateAccess(dm, undefined)).toEqual(dmOnly);
    expect(defaultTriggerCreateAccess(dm, { mode: 'project' })).toEqual(dmOnly);
  });

  test('with no sharing in the body: project-visible in a channel, private without a space', () => {
    expect(defaultTriggerCreateAccess(channel, undefined)).toEqual(PROJECT_TRIGGER_SESSION_ACCESS);
    expect(defaultTriggerCreateAccess(null, undefined)).toEqual(PRIVATE_TRIGGER_SESSION_ACCESS);
  });

  test('a sharing in the body decides outside a DM', () => {
    expect(defaultTriggerCreateAccess(channel, members)).toBeUndefined();
    expect(defaultTriggerCreateAccess(null, members)).toBeUndefined();
  });
});
