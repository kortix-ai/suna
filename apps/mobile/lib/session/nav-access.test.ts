import { describe, expect, test } from 'bun:test';
import { REVIEW_ACCESS, appsRowVisible, navAccessAllowed } from './nav-access';

const cans = (allowed: string[], loading = false) =>
  new Proxy({} as Record<string, { allowed: boolean; isLoading: boolean }>, {
    get: (_, action: string) => ({ allowed: allowed.includes(action), isLoading: loading }),
  });

describe('navAccessAllowed', () => {
  test('Review needs read AND act', () => {
    expect(navAccessAllowed(cans(['project.review.read']), REVIEW_ACCESS)).toBe(false);
    expect(navAccessAllowed(cans(['project.review.read', 'project.review.act']), REVIEW_ACCESS)).toBe(true);
  });
  test('nothing shows before the verdict lands', () => {
    expect(navAccessAllowed(cans(['project.review.read', 'project.review.act'], true), REVIEW_ACCESS)).toBe(false);
    expect(navAccessAllowed({}, REVIEW_ACCESS)).toBe(false);
  });
});

describe('appsRowVisible', () => {
  test('deploy leaf shows the row', () => expect(appsRowVisible(cans(['project.app.deploy']), 0)).toBe(true));
  test('without deploy, an existing App shows it', () => {
    expect(appsRowVisible(cans([]), 1)).toBe(true);
    expect(appsRowVisible(cans([]), 0)).toBe(false);
    expect(appsRowVisible(cans([]), undefined)).toBe(false);
  });
  test('hidden while the verdict loads', () => expect(appsRowVisible(cans([], true), 3)).toBe(false));
});
