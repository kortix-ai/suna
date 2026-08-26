import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The sidebar must not prefetch its whole list on mount.
 *
 * Measured on a production build (`next build` + `next start`, 20 sessions in
 * the sidebar, one session open, Playwright request counter):
 *
 *   before  221 requests, 21 RSC fetches of /projects/[id]/sessions/[sessionId]
 *   after   192 requests,  1 RSC fetch  of /projects/[id]/sessions/[sessionId]
 *
 * Twenty of those 21 were `<Link>`'s automatic viewport prefetch firing for
 * every OTHER session row — each one a dynamic server render of a full session
 * page (~24KB of flight payload, median 480ms on the Essentia deployment,
 * 423 hits across a 20-open HAR corpus). The same shape charged /files,
 * /apps and /customize two requests each per open.
 *
 * `next dev` disables Link prefetching, so this regression is invisible in
 * local development and in the dev-stack browser lane — which is exactly why it
 * is pinned here as a source contract instead of a Playwright assertion.
 *
 * The fix is `HoverPrefetchLink` (components/common/hover-prefetch-link.tsx):
 * prefetch on hover/focus/touch, which still lands 100-300ms before the click.
 * Reintroducing a bare `next/link` in any of these files silently restores the
 * storm, so importing one here is the failure.
 */
const dir = import.meta.dir;
const read = (relative: string) => readFileSync(join(dir, relative), 'utf8');
const strip = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const LIST_FILES = [
  'project-session-list.tsx',
  'project-settings-nav.tsx',
  'footer/project-files-nav.tsx',
  'footer/project-apps-nav.tsx',
] as const;

describe('sidebar prefetch contract', () => {
  for (const file of LIST_FILES) {
    test(`${file} routes navigation through HoverPrefetchLink, not next/link`, () => {
      const code = strip(read(file));
      expect(code).not.toContain("from 'next/link'");
      expect(code).not.toMatch(/<Link[\s>]/);
      expect(code).toContain('HoverPrefetchLink');
    });
  }

  test('every session row in the list is a HoverPrefetchLink', () => {
    const code = strip(read('project-session-list.tsx'));
    // ProjectSessionRow (one per session) and ProjectSubsessionRow (one per
    // spawned sub-session) are the two row components the list renders N times.
    const opens = code.match(/<HoverPrefetchLink[\s>]/g) ?? [];
    expect(opens.length).toBeGreaterThanOrEqual(3);
    expect(code).toContain('</HoverPrefetchLink>');
  });

  test('HoverPrefetchLink defers the prefetch until pointer, focus or touch', () => {
    const code = strip(readFileSync(join(dir, '../../../components/common/hover-prefetch-link.tsx'), 'utf8'));
    // The whole mechanism: `false` until armed, the caller's kind afterwards.
    expect(code).toContain('prefetch={armed ? prefetch : false}');
    expect(code).toMatch(/onMouseEnter=\{\(event\) => \{\s*setArmed\(true\)/);
    expect(code).toMatch(/onFocus=\{\(event\) => \{\s*setArmed\(true\)/);
    expect(code).toMatch(/onTouchStart=\{\(event\) => \{\s*setArmed\(true\)/);
    // Spreading props BEFORE the prefetch prop is what keeps a caller from
    // accidentally re-enabling mount-time prefetching.
    expect(code.indexOf('{...props}')).toBeLessThan(code.indexOf('prefetch={armed'));
  });
});
