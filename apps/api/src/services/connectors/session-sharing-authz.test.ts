import { describe, expect, test } from 'bun:test';

import {
  mayManageSessionSharing,
  sharingChangeKeepsEditorAccess,
  type SecretGrant,
  type ShareSubject,
} from './share';

const subject = (userId: string, groupIds: string[] = []): ShareSubject => ({ userId, groupIds });
const member = (id: string): SecretGrant => ({ principalType: 'member', principalId: id });
const group = (id: string): SecretGrant => ({ principalType: 'group', principalId: id });

describe('mayManageSessionSharing', () => {
  test('the owner always governs their own session', () => {
    expect(
      mayManageSessionSharing({ isOwner: true, canManageProject: false, ownerIsMachine: false }),
    ).toBe(true);
  });

  test('a project manager may NOT re-share a session another human owns', () => {
    // The escalation this closes: a manager cannot READ another human's private
    // session (isProjectSessionVisibleTo grants the manager override to
    // trigger-created sessions only). Flipping it to `project` and then reading
    // it would defeat that gate entirely.
    expect(
      mayManageSessionSharing({ isOwner: false, canManageProject: true, ownerIsMachine: false }),
    ).toBe(false);
  });

  test('a project manager governs a machine-owned session', () => {
    // A trigger/agent run is stamped with the agent's service-account id. There
    // is no human owner, so owner-only would make the policy unchangeable.
    expect(
      mayManageSessionSharing({ isOwner: false, canManageProject: true, ownerIsMachine: true }),
    ).toBe(true);
  });

  test('a plain member gains nothing from a machine-owned session', () => {
    expect(
      mayManageSessionSharing({ isOwner: false, canManageProject: false, ownerIsMachine: true }),
    ).toBe(false);
  });
});

describe('sharingChangeKeepsEditorAccess', () => {
  test('the owner can pick any mode — every one of them keeps the owner', () => {
    expect(
      sharingChangeKeepsEditorAccess({
        isOwner: true,
        visibility: 'private',
        grants: [],
        subject: subject('alice'),
      }),
    ).toBe(true);
  });

  test('a non-owner choosing private would lock themselves out', () => {
    // The reported bug: `private` means "the OWNER only". A manager editing a
    // machine-owned session and saving `private` loses the session for good —
    // undoing it needs the read the save just revoked.
    expect(
      sharingChangeKeepsEditorAccess({
        isOwner: false,
        visibility: 'private',
        grants: [],
        subject: subject('manager'),
      }),
    ).toBe(false);
  });

  test('a non-owner may widen to the whole project', () => {
    expect(
      sharingChangeKeepsEditorAccess({
        isOwner: false,
        visibility: 'project',
        grants: [],
        subject: subject('manager'),
      }),
    ).toBe(true);
  });

  test('a non-owner restricting to a list that omits them is refused', () => {
    expect(
      sharingChangeKeepsEditorAccess({
        isOwner: false,
        visibility: 'restricted',
        grants: [member('alice')],
        subject: subject('manager'),
      }),
    ).toBe(false);
  });

  test('a non-owner restricting to a list that names them is allowed', () => {
    expect(
      sharingChangeKeepsEditorAccess({
        isOwner: false,
        visibility: 'restricted',
        grants: [member('alice'), member('manager')],
        subject: subject('manager'),
      }),
    ).toBe(true);
  });

  test('a group the editor belongs to counts as keeping their access', () => {
    expect(
      sharingChangeKeepsEditorAccess({
        isOwner: false,
        visibility: 'restricted',
        grants: [group('platform')],
        subject: subject('manager', ['platform']),
      }),
    ).toBe(true);
  });
});
