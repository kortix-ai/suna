import { describe, expect, test } from 'bun:test';
import { audienceReachOf } from './connection-audience';

const noGroups = new Set<string>();

describe('audienceReachOf', () => {
  test('an account nobody narrowed is open', () => {
    expect(audienceReachOf(undefined, 'user-1', noGroups)).toBe('open');
    expect(audienceReachOf([], null, noGroups)).toBe('open');
  });

  test('a grant to everyone in the project keeps it open, beside any other grant', () => {
    const grants = [
      { principalType: 'group', principalId: 'sales' },
      { principalType: 'project', principalId: 'project-1' },
    ];
    expect(audienceReachOf(grants, 'user-1', noGroups)).toBe('open');
    expect(audienceReachOf(grants, null, noGroups)).toBe('open');
  });

  test('a narrowed account names a member directly or through a group', () => {
    const grants = [
      { principalType: 'user', principalId: 'user-1' },
      { principalType: 'group', principalId: 'sales' },
    ];
    expect(audienceReachOf(grants, 'user-1', noGroups)).toBe('in');
    expect(audienceReachOf(grants, 'user-2', new Set(['sales']))).toBe('in');
    expect(audienceReachOf(grants, 'user-2', new Set(['eng']))).toBe('out');
  });

  test('an unattended run is in no narrowed audience', () => {
    const grants = [{ principalType: 'group', principalId: 'sales' }];
    expect(audienceReachOf(grants, null, new Set(['sales']))).toBe('out');
  });
});
