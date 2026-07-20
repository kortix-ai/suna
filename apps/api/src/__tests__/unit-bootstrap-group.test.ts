// Unit coverage for the `{ group_id }` bootstrap entry validator — the gate that
// decides whether a parked SCIM Group membership materializes on invite accept.
// Malformed jsonb must be rejected (null), never fed into account_group_members.
import { describe, expect, test } from 'bun:test';
import { validateBootstrapGroup } from '../accounts/invites';
import { parseGroupPut, resolveInviteMemberAction, stripGroupGrant } from '../scim/groups';

const UUID = '5888c520-d8f0-489a-a807-d2f8bf007fd1';

describe('validateBootstrapGroup', () => {
  test('accepts a well-formed group_id entry', () => {
    expect(validateBootstrapGroup({ group_id: UUID })).toEqual({ group_id: UUID });
  });

  test('rejects a project-grant entry so it falls through to the grant path', () => {
    expect(validateBootstrapGroup({ project_id: UUID, role: 'member' })).toBeNull();
  });

  test('rejects a non-uuid group_id', () => {
    expect(validateBootstrapGroup({ group_id: 'not-a-uuid' })).toBeNull();
    expect(validateBootstrapGroup({ group_id: '' })).toBeNull();
  });

  test('rejects non-objects and empty objects', () => {
    expect(validateBootstrapGroup(null)).toBeNull();
    expect(validateBootstrapGroup('x')).toBeNull();
    expect(validateBootstrapGroup(42)).toBeNull();
    expect(validateBootstrapGroup({})).toBeNull();
  });
});

// The Azure gotcha: the IdP keeps referencing a user by the invitation id it
// got at provisioning time, but the person can become a member via SSO JIT
// WITHOUT accepting the invite — parking on that invite strands the
// membership forever. The decision must add live members directly.
describe('resolveInviteMemberAction', () => {
  test('person already a member (SSO JIT or accepted invite) → add directly', () => {
    expect(resolveInviteMemberAction({ accepted: false, resolvedMemberUserId: UUID })).toBe(
      'add-member',
    );
    expect(resolveInviteMemberAction({ accepted: true, resolvedMemberUserId: UUID })).toBe(
      'add-member',
    );
  });

  test('truly pending (no member, not accepted) → park on the invite', () => {
    expect(resolveInviteMemberAction({ accepted: false, resolvedMemberUserId: null })).toBe('park');
  });

  test('accepted but membership since removed → skip (not a group PATCH decision)', () => {
    expect(resolveInviteMemberAction({ accepted: true, resolvedMemberUserId: null })).toBe('skip');
  });
});

// Un-parking is the flip side of parking: an IdP that removes a
// not-yet-signed-in person from a group (or replaces the member set) must
// strip the parked grant, or the person joins at first sign-in anyway.
describe('stripGroupGrant', () => {
  const OTHER = '22fc7147-483d-44fe-a824-763622eec789';

  test('removes only the matching group entry', () => {
    const grants = [{ group_id: UUID }, { group_id: OTHER }];
    const { changed, remaining } = stripGroupGrant(grants, UUID);
    expect(changed).toBe(true);
    expect(remaining).toEqual([{ group_id: OTHER }]);
  });

  test('project grants pass through untouched', () => {
    const grants = [{ project_id: OTHER, role: 'member' }, { group_id: UUID }];
    const { changed, remaining } = stripGroupGrant(grants, UUID);
    expect(changed).toBe(true);
    expect(remaining).toEqual([{ project_id: OTHER, role: 'member' }]);
  });

  test('no match → unchanged (no pointless DB write)', () => {
    const grants = [{ group_id: OTHER }];
    const { changed, remaining } = stripGroupGrant(grants, UUID);
    expect(changed).toBe(false);
    expect(remaining).toEqual(grants);
  });

  test('null/empty grants are safe', () => {
    expect(stripGroupGrant(null, UUID)).toEqual({ changed: false, remaining: [] });
    expect(stripGroupGrant(undefined, UUID)).toEqual({ changed: false, remaining: [] });
    expect(stripGroupGrant([], UUID)).toEqual({ changed: false, remaining: [] });
  });
});

// Group PUT body interpretation — Okta group-push renames arrive as PUT with
// the full resource. Omitted fields must mean "leave alone" (a partial client
// must not wipe a group), while a PRESENT members array — even empty — is the
// IdP's authoritative member list.
describe('parseGroupPut', () => {
  test('a rename-only PUT changes the name and leaves members alone', () => {
    expect(parseGroupPut({ displayName: 'Platform Team' })).toEqual({
      displayName: 'Platform Team',
      externalId: null,
      members: null,
    });
  });

  test('a full Okta-style body extracts name + member values', () => {
    expect(
      parseGroupPut({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
        id: UUID,
        displayName: 'Engineers',
        members: [{ value: 'user-1', display: 'A' }, { value: 'user-2' }],
      }),
    ).toEqual({ displayName: 'Engineers', externalId: null, members: ['user-1', 'user-2'] });
  });

  test('an EMPTY members array is authoritative (clears the group), absent is not', () => {
    expect(parseGroupPut({ displayName: 'X', members: [] }).members).toEqual([]);
    expect(parseGroupPut({ displayName: 'X' }).members).toBeNull();
  });

  test('junk member entries and whitespace names are dropped', () => {
    expect(
      parseGroupPut({
        displayName: '   ',
        externalId: '  ext-9 ',
        members: [{ value: 42 }, { display: 'no value' }, { value: 'ok' }],
      }),
    ).toEqual({ displayName: null, externalId: 'ext-9', members: ['ok'] });
  });
});
