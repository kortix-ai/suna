// Unit coverage for the `{ group_id }` bootstrap entry validator — the gate that
// decides whether a parked SCIM Group membership materializes on invite accept.
// Malformed jsonb must be rejected (null), never fed into account_group_members.
import { describe, expect, test } from 'bun:test';
import { validateBootstrapGroup } from '../accounts/invites';

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
