import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const page = readFileSync(join(import.meta.dir, 'page.tsx'), 'utf8');

describe('/projects index', () => {
  test('is a redirect, not a list', () => {
    expect(page).toContain('redirect');
    expect(page).not.toContain('ProjectCard');
    expect(page).not.toContain('ProjectsViewMode');
    expect(page).not.toContain('archiveProject');
  });

  test('redirects to the landing door, which resolves a real workspace', () => {
    expect(page).toContain('PROJECT_LANDING_PATH');
  });

  test('is small enough to read at a glance', () => {
    expect(page.split('\n').length).toBeLessThan(30);
  });
});
