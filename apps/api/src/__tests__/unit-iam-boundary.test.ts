// Pure unit coverage for actionPassesBoundary — the action-prefix
// matcher used by the permission-boundary clip.

import { describe, expect, test } from 'bun:test';
import { actionPassesBoundary } from '../iam/engine';

describe('actionPassesBoundary', () => {
  test('exact match passes', () => {
    expect(actionPassesBoundary('project.read', { allow_action_prefixes: ['project.read'] })).toBe(true);
  });

  test('dot-suffix prefix covers descendants', () => {
    const b = { allow_action_prefixes: ['project.'] };
    expect(actionPassesBoundary('project.read', b)).toBe(true);
    expect(actionPassesBoundary('project.session.start', b)).toBe(true);
    expect(actionPassesBoundary('projects.read', b)).toBe(false); // not a real prefix
    expect(actionPassesBoundary('sandbox.read', b)).toBe(false);
  });

  test('no-dot prefix still covers descendants under that namespace', () => {
    // "project" without trailing dot is treated as "project.*"
    const b = { allow_action_prefixes: ['project'] };
    expect(actionPassesBoundary('project.read', b)).toBe(true);
    expect(actionPassesBoundary('projection.read', b)).toBe(false);
  });

  test('multiple prefixes — OR semantics', () => {
    const b = { allow_action_prefixes: ['project.', 'sandbox.read'] };
    expect(actionPassesBoundary('project.write', b)).toBe(true);
    expect(actionPassesBoundary('sandbox.read', b)).toBe(true);
    expect(actionPassesBoundary('sandbox.exec', b)).toBe(false);
  });

  test('empty prefix list denies everything (admin deny-all opt-in)', () => {
    expect(actionPassesBoundary('project.read', { allow_action_prefixes: [] })).toBe(false);
  });
});
