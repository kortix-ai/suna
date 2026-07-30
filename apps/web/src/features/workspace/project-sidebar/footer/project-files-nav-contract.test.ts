import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE = readFileSync(resolve(import.meta.dir, 'project-customize-nav.tsx'), 'utf8');

/** The ProjectFilesNavItem function body, isolated from its neighbours. */
function filesNavItemSource(): string {
  const start = SOURCE.indexOf('export function ProjectFilesNavItem');
  expect(start).toBeGreaterThan(-1);
  const after = SOURCE.indexOf('export function', start + 1);
  return after === -1 ? SOURCE.slice(start) : SOURCE.slice(start, after);
}

describe('project Files sidebar entry', () => {
  test('navigates with a prefetching Link, not router.push', () => {
    // A button + router.push cannot be prefetched, so every click paid for the
    // RSC payload and the route chunk cold. Reverting to router.push silently
    // restores a 5-6s navigation; this test is the tripwire.
    const navItem = filesNavItemSource();

    expect(navItem).toContain('<Link');
    // toContain('prefetch') alone is vacuous: `prefetch={false}` also contains
    // the substring "prefetch" and would pass, silently restoring the 5-6s
    // navigation this test exists to prevent. Require the bare/enabled form and
    // explicitly reject the disabled form.
    expect(navItem).toMatch(/prefetch(\s|>|$)/);
    expect(navItem).not.toContain('prefetch={false}');
    // href was previously unasserted, so `<Link href="#">` would have passed.
    expect(navItem).toMatch(/href=\{`\/projects\/\$\{projectId\}\/files`\}/);
    expect(navItem).toContain('asChild');
    expect(navItem).not.toContain('router.push');
  });

  test('still hides itself for callers without project.file.read', () => {
    const navItem = filesNavItemSource();

    expect(navItem).toContain('PROJECT_FILE_READ');
    expect(navItem).toContain('!canReadFiles.allowed && !canReadFiles.isLoading');
  });

  test('still closes the mobile drawer on navigate', () => {
    const navItem = filesNavItemSource();

    expect(navItem).toContain('setOpenMobile(false)');
  });

  test('does not retain the router.push helper the rail used', () => {
    // useFilesActivate was the unprefetchable path. Its last consumer
    // (ProjectFilesRailItem) is dead code, so keeping it around would just
    // leave a trap for the next editor.
    expect(SOURCE).not.toContain('useFilesActivate');
    expect(SOURCE).not.toContain('ProjectFilesRailItem');
  });
});
