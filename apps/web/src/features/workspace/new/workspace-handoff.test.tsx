import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import { stripTags } from '@/test-utils/strip-tags';
import { WorkspaceHandoff } from './workspace-handoff';

const render = (props: Parameters<typeof WorkspaceHandoff>[0]) =>
  renderToStaticMarkup(<WorkspaceHandoff {...props} />);

const source = readFileSync(join(import.meta.dir, 'workspace-handoff.tsx'), 'utf8');

/** The `<svg>` the Kortix mark renders into, cells and all. */
const markup = (html: string): string => html.match(/<svg[\s\S]*<\/svg>/)?.[0] ?? '';

describe('WorkspaceHandoff', () => {
  test('announces itself as a status, with the caption as the content', () => {
    const html = render({ workspaceName: 'suna-web', projectId: null });
    expect(html).toContain('role="status"');
    // Explicit alongside the role, for ATs that do not map role=status to a
    // polite live region.
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-busy="true"');
    expect(stripTags(html)).toContain('Creating suna-web');
  });

  test('the mark is decoration — hidden from the accessibility tree', () => {
    const html = render({ workspaceName: 'x', projectId: null });
    expect(markup(html)).toContain('aria-hidden="true"');
  });

  test('ONE mark across both waiting windows — byte-identical with and without a project', () => {
    // This is the whole point of the component: the moment the create SUCCEEDS
    // must not be rendered as the waiting UI being torn down and replaced.
    // If these two ever diverge, the seam is visible again.
    const creating = markup(render({ workspaceName: 'x', projectId: null }));
    const onboarding = markup(render({ workspaceName: 'x', projectId: 'proj-1' }));
    expect(creating).not.toBe('');
    expect(onboarding).toBe(creating);
  });

  test('the caption is the same string in both windows, so nothing flickers at the seam', () => {
    const creating = stripTags(render({ workspaceName: 'suna-web', projectId: null }));
    const onboarding = stripTags(render({ workspaceName: 'suna-web', projectId: 'proj-1' }));
    expect(creating).toContain('Creating suna-web');
    expect(onboarding).toContain('Creating suna-web');
  });

  test('a reload of /new?onboarding=<id> has no name, and says something true instead', () => {
    // `state.name` is the form's own useState, so a reload arrives with it
    // empty. The workspace exists by then — this is always window 2.
    const html = render({ workspaceName: '', projectId: 'proj-1' });
    const text = stripTags(html);
    expect(text).toContain('Opening your workspace');
    expect(text).not.toContain('Creating ');
  });

  test('no escape hatch while the create is still in flight — there is nowhere to go yet', () => {
    const html = render({ workspaceName: 'x', projectId: null });
    expect(html).not.toContain('Go to workspace');
    expect(html).not.toContain('<a ');
  });

  test('once the project exists, the escape hatch links to it, percent-encoded', () => {
    // Mirrors `onboardingPath` on the way in — asymmetric encoding builds a
    // broken URL for any id carrying a character that is not URL-safe.
    const html = render({ workspaceName: 'x', projectId: 'proj/1 2' });
    expect(html).toContain('Go to workspace');
    expect(html).toContain('href="/projects/proj%2F1%202"');
    expect(html).not.toContain('href="/projects/proj/1 2"');
  });

  test('the escape hatch reuses the page-wide quiet-control treatment', () => {
    // Same as `Log out` and `Try again` on `/new` — no third button weight.
    const html = render({ workspaceName: 'x', projectId: 'proj-1' });
    expect(html).toContain('text-muted-foreground hover:text-foreground');
  });

  test('the escape hatch waits, so it is never seen on the normal path', () => {
    // The wizard is a fullscreen portal and covers this screen as soon as
    // `getProjectDetail` settles. An immediate link would put "Go to
    // workspace" on screen during every successful create — an offer to leave
    // at the exact point the user is being taken somewhere.
    const escapeIn = source.match(/const ESCAPE_IN = \{([^}]*)\}/)?.[1] ?? '';
    expect(escapeIn).toContain('delay:');
    const delay = Number(escapeIn.match(/delay:\s*([\d.]+)/)?.[1]);
    expect(delay).toBeGreaterThan(1);
    // ...and it renders at opacity 0, so the delay is a real wait rather than
    // a late mount that would pop into layout.
    expect(render({ workspaceName: 'x', projectId: 'proj-1' })).toContain('style="opacity:0"');
  });

  test('the caption lands one beat behind the mark, not with it', () => {
    const captionIn = source.match(/const CAPTION_IN = \{([^}]*)\}/)?.[1] ?? '';
    const delay = Number(captionIn.match(/delay:\s*([\d.]+)/)?.[1]);
    expect(delay).toBeGreaterThan(0);
    // Within the doctrine's stagger range — long enough to read as sequence,
    // short enough that it is not a second event.
    expect(delay).toBeLessThan(0.3);
  });

  test('the mark is the app-wide loader, driven as a loop rather than a one-shot', () => {
    // Same component and same `loop` as `RouteLoadingFallback`, so waiting
    // looks the same here as on every route transition.
    expect(source).toContain("from '@/components/ui/marketing/kortix-hyper-logo'");
    expect(source).toContain('loop');
    // Nothing scrolls this into view — it swaps in where the form was, so an
    // IntersectionObserver would only delay it.
    expect(source).toContain('startOnView={false}');
  });

  test('reduced motion drops the caption travel but keeps the fade', () => {
    // Removing MOVEMENT, not meaning: the caption still fades so its arrival
    // is legible, it just does not travel.
    expect(source).toContain('useReducedMotion');
    expect(source).toContain('reduceMotion ? { opacity: 0 } : { opacity: 0, y: 4 }');
  });

  test('the mark resolves before the caption travels — no y on the default render', () => {
    // Paired negative for the branch above: the non-reduced path really does
    // carry the transform, so the reduced branch is removing something.
    expect(render({ workspaceName: 'x', projectId: null })).toContain('translateY(4px)');
  });
});
