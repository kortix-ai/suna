import { describe, expect, test } from 'bun:test';
import { applyProfile, ENTERPRISE_USER_SCHEMA, userChanges } from './user-profile';
import type { DirectoryUser } from './directory-users';

const user = { profile: {}, userName: 'fixture@example.test', externalId: null } as DirectoryUser;

describe('SCIM user profile', () => {
  test('preserves ordered add, replace, and remove operations for multivalued attributes', () => {
    const result = applyProfile(user, userChanges({ Operations: [
      { op: 'add', value: { phoneNumbers: [{ type: 'work', value: '1' }] } },
      { op: 'add', path: 'phoneNumbers', value: [{ type: 'fax', value: '2' }] },
      { op: 'remove', path: 'phoneNumbers[type eq "work"]' },
      { op: 'replace', path: 'phoneNumbers[type eq "fax"].value', value: '3' },
    ] }, true));
    expect(result.profile.phoneNumbers).toEqual([{ type: 'fax', value: '3' }]);
    expect(user.profile).toEqual({});
  });

  test('normalizes attribute names without changing values and removes enterprise fields independently', () => {
    const result = applyProfile(user, userChanges({ Operations: [
      { op: 'add', value: { [ENTERPRISE_USER_SCHEMA]: { department: 'Engineering', manager: { value: 'manager-id' } } } },
      { op: 'replace', path: 'Addresses[type EQ "WORK"].streetAddress', value: 'Case Preserved' },
      { op: 'remove', path: `${ENTERPRISE_USER_SCHEMA}:department` },
    ] }, true));
    expect(result.profile.addresses).toEqual([{ type: 'work', streetAddress: 'Case Preserved' }]);
    expect(result.profile[ENTERPRISE_USER_SCHEMA]).toEqual({ manager: { value: 'manager-id' } });
  });

  test.each(['__proto__', 'constructor', 'name.constructor', 'addresses[type eq "work"].__proto__', `${ENTERPRISE_USER_SCHEMA}:__proto__`])('rejects unsafe or unknown path %s', path => {
    expect(() => userChanges({ Operations: [{ op: 'replace', path, value: 'bad' }] }, true)).toThrow('Unsupported user attribute');
  });

  test.each([
    { phoneNumbers: [{ value: 1 }] },
    { addresses: [{ primary: 'yes' }] },
    { preferredLanguage: false },
    { [ENTERPRISE_USER_SCHEMA]: { manager: [] } },
  ])('rejects malformed profile values', body => {
    expect(() => userChanges(body)).toThrow();
  });
});
