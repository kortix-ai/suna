/**
 * Personal provider keys under the agent-principal model (spec
 * docs/specs/2026-09-22-agents-as-principals.md §2.3).
 */
import { describe, expect, test } from 'bun:test';
import { personalKeyGranted, secretUsableInProject } from './account-resource';

describe('personalKeyGranted', () => {
  test("the on-behalf-of human's own grant counts", () => {
    expect(personalKeyGranted('human', 'human')).toBe(true);
  });
  test("another member's grant never counts", () => {
    expect(personalKeyGranted('other', 'human')).toBe(false);
  });
  test('no personal owner (unattended, shared, cleared): no grant counts, not even a null row', () => {
    expect(personalKeyGranted('human', null)).toBe(false);
    expect(personalKeyGranted(null, null)).toBe(false);
  });
  test('project-mode keys stay usable without a personal owner', () => {
    expect(secretUsableInProject({ projectId: null, accessMode: 'project' }, 'p', personalKeyGranted(null, null))).toBe(true);
    expect(secretUsableInProject({ projectId: null, accessMode: 'private' }, 'p', personalKeyGranted(null, null))).toBe(false);
  });
});
