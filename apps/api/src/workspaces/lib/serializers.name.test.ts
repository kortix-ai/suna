import { describe, expect, test } from 'bun:test';
import { WORKSPACE_NAME_MAX_LENGTH, clampWorkspaceName } from './serializers';

describe('clampWorkspaceName', () => {
  test('returns short names unchanged', () => {
    expect(clampWorkspaceName('My First Workspace')).toBe('My First Workspace');
  });

  test('clamps names longer than the cap and trims trailing spaces', () => {
    const pasted = `${'word '.repeat(60)}tail`;
    const clamped = clampWorkspaceName(pasted);
    expect(clamped.length).toBeLessThanOrEqual(WORKSPACE_NAME_MAX_LENGTH);
    expect(clamped.endsWith(' ')).toBe(false);
  });

  test('exact-cap names pass through untouched', () => {
    const exact = 'a'.repeat(WORKSPACE_NAME_MAX_LENGTH);
    expect(clampWorkspaceName(exact)).toBe(exact);
  });

  test('cap stays within the projects.name varchar(255) column', () => {
    expect(WORKSPACE_NAME_MAX_LENGTH).toBeLessThanOrEqual(255);
  });
});
