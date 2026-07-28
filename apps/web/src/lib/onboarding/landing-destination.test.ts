import { describe, expect, test } from 'bun:test';

import {
  PROJECT_LANDING_PATH,
  isValidProjectId,
  projectPathFromId,
  resolveDefaultLandingPath,
} from './landing-destination';

const VALID = '11111111-1111-4111-8111-111111111111';

describe('isValidProjectId', () => {
  test('accepts a UUID in either case', () => {
    expect(isValidProjectId(VALID)).toBe(true);
    expect(isValidProjectId(VALID.toUpperCase())).toBe(true);
  });

  test('rejects everything that is not a UUID', () => {
    for (const value of [
      null,
      undefined,
      '',
      'start',
      `${VALID} `,
      `${VALID}/../../admin`,
      '../../etc/passwd',
      'https://evil.example.com',
      '//evil.example.com',
      `${VALID}?next=/admin`,
      '1111111-1111-4111-8111-111111111111',
    ]) {
      expect(isValidProjectId(value as string | null | undefined)).toBe(false);
    }
  });
});

describe('projectPathFromId', () => {
  test('builds the project path for a valid id', () => {
    expect(projectPathFromId(VALID)).toBe(`/projects/${VALID}`);
  });

  test('returns null rather than a path for untrusted input', () => {
    expect(projectPathFromId('//evil.example.com')).toBeNull();
    expect(projectPathFromId(null)).toBeNull();
  });
});

describe('resolveDefaultLandingPath', () => {
  test('sends a remembered project straight to its page', () => {
    expect(resolveDefaultLandingPath(VALID)).toBe(`/projects/${VALID}`);
  });

  test('falls back to the landing door, never to the projects list', () => {
    // The regression this guards: the default destination silently reverting to
    // the `/projects` list, which is the manual-selection step we removed.
    expect(resolveDefaultLandingPath(null)).toBe(PROJECT_LANDING_PATH);
    expect(resolveDefaultLandingPath('nonsense')).toBe(PROJECT_LANDING_PATH);
    expect(resolveDefaultLandingPath(PROJECT_LANDING_PATH)).toBe(PROJECT_LANDING_PATH);
  });

  test('a tampered cookie can never produce an off-origin redirect', () => {
    for (const hostile of [
      'https://evil.example.com',
      '//evil.example.com',
      '/admin',
      '../admin',
    ]) {
      expect(resolveDefaultLandingPath(hostile)).toBe(PROJECT_LANDING_PATH);
    }
  });
});
