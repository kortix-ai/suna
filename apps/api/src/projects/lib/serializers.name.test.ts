import { describe, expect, test } from 'bun:test';
import { PROJECT_NAME_MAX_LENGTH, clampProjectName } from './serializers';

describe('clampProjectName', () => {
  test('returns short names unchanged', () => {
    expect(clampProjectName('My First Project')).toBe('My First Project');
  });

  test('clamps names longer than the cap and trims trailing spaces', () => {
    const pasted = `${'word '.repeat(60)}tail`;
    const clamped = clampProjectName(pasted);
    expect(clamped.length).toBeLessThanOrEqual(PROJECT_NAME_MAX_LENGTH);
    expect(clamped.endsWith(' ')).toBe(false);
  });

  test('exact-cap names pass through untouched', () => {
    const exact = 'a'.repeat(PROJECT_NAME_MAX_LENGTH);
    expect(clampProjectName(exact)).toBe(exact);
  });

  test('cap stays within the projects.name varchar(255) column', () => {
    expect(PROJECT_NAME_MAX_LENGTH).toBeLessThanOrEqual(255);
  });
});
