import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * KRTX-2491: `/projects/<id>/settings` opened the ACCOUNT settings overlay on
 * Profile — a project-titled page whose danger zone offered "Delete account" to
 * someone looking for the project's settings. The project's own settings page
 * is `/customize/settings`; the bare URL (and every project-scoped fallback
 * that lands on it) now goes there.
 */
const source = readFileSync(join(import.meta.dir, 'page.tsx'), 'utf8');

test('the bare project settings URL lands on the project settings page', () => {
  expect(source).toContain('router.replace(`/projects/${projectId}/customize/settings`)');
});

test('it never opens the account settings overlay', () => {
  expect(source).not.toContain('openSettings(');
});
