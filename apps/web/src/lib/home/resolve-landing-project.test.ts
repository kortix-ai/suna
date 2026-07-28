import { describe, expect, test } from 'bun:test';

import {
  MAX_ACCOUNTS_TO_SEARCH,
  resolveLandingPath,
  resolveLandingProjectId,
  sortByLastOpened,
} from './resolve-landing-project';

const A = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const B = '9c858901-8a57-4791-81fe-4c455b099bc9';
const C = '7d444840-9dc0-11d1-b245-5ffdce74fad2';

const p = (id: string, last_opened_at: string | null = null) => ({
  project_id: id,
  last_opened_at,
});

describe('sortByLastOpened', () => {
  test('puts the most recently opened first and never-opened last', () => {
    const out = sortByLastOpened([
      p(A, '2026-01-01T00:00:00Z'),
      p(B, null),
      p(C, '2026-06-01T00:00:00Z'),
    ]);
    expect(out.map((x) => x.project_id)).toEqual([C, A, B]);
  });

  test('does not mutate its input', () => {
    const input = [p(A, '2026-01-01T00:00:00Z'), p(C, '2026-06-01T00:00:00Z')];
    sortByLastOpened(input);
    expect(input[0].project_id).toBe(A);
  });
});

describe('resolveLandingProjectId', () => {
  test('honours the cookie when the project is still visible', () => {
    expect(resolveLandingProjectId({ cookieProjectId: B, projectsByAccount: [[p(A), p(B)]] })).toBe(
      B,
    );
  });

  test('ignores a cookie for a project the user can no longer see', () => {
    // Deleted, archived, or access revoked — otherwise every visit 404s.
    expect(
      resolveLandingProjectId({ cookieProjectId: C, projectsByAccount: [[p(A, '2026-01-01')]] }),
    ).toBe(A);
  });

  test('ignores a malformed cookie', () => {
    expect(
      resolveLandingProjectId({
        cookieProjectId: '../admin',
        projectsByAccount: [[p(A, '2026-01-01')]],
      }),
    ).toBe(A);
  });

  test('falls back to the most recently opened project', () => {
    expect(
      resolveLandingProjectId({
        projectsByAccount: [[p(A, '2026-01-01T00:00:00Z'), p(B, '2026-06-01T00:00:00Z')]],
      }),
    ).toBe(B);
  });

  test('searches later accounts when the first has none', () => {
    expect(resolveLandingProjectId({ projectsByAccount: [[], [p(C, '2026-02-02')]] })).toBe(C);
  });

  test('returns null when there is nothing to open', () => {
    expect(resolveLandingProjectId({ projectsByAccount: [] })).toBeNull();
    expect(resolveLandingProjectId({ projectsByAccount: [[], []] })).toBeNull();
  });

  test('tolerates entries with no project_id', () => {
    expect(resolveLandingProjectId({ projectsByAccount: [[{ project_id: null }, p(A)]] })).toBe(A);
  });
});

describe('resolveLandingPath', () => {
  test('builds the project path', () => {
    expect(resolveLandingPath({ cookieProjectId: A, projectsByAccount: [[p(A)]] })).toBe(
      `/projects/${A}`,
    );
  });

  test('falls back to the project list rather than a dead end', () => {
    expect(resolveLandingPath({ projectsByAccount: [] })).toBe('/projects');
  });

  test('never throws, and never sends the user off-site', () => {
    const hostile = {
      get projectsByAccount(): never {
        throw new Error('backend down');
      },
    } as unknown as Parameters<typeof resolveLandingPath>[0];
    // A backend blip must not turn the homepage into a login wall.
    expect(resolveLandingPath(hostile)).toBe('/projects');
  });

  test('every result stays under /projects', () => {
    const out = resolveLandingPath({ cookieProjectId: A, projectsByAccount: [[p(A)]] });
    expect(out.startsWith('/projects')).toBe(true);
    expect(out).not.toContain('//');
  });
});

describe('account sweep cap', () => {
  test('is small enough that a many-org user does not wait on every account', () => {
    expect(MAX_ACCOUNTS_TO_SEARCH).toBeLessThanOrEqual(3);
    expect(MAX_ACCOUNTS_TO_SEARCH).toBeGreaterThan(0);
  });
});
