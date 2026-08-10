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
    const html = render({ workspaceName: 'suna-web', workspaceId: null });
    expect(html).toContain('role="status"');
    // Explicit alongside the role, for ATs that do not map role=status to a
    // polite live region.
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-busy="true"');
    expect(stripTags(html)).toContain('Creating suna-web');
  });

  test('the mark is decoration — hidden from the accessibility tree', () => {
    const html = render({ workspaceName: 'x', workspaceId: null });
    expect(markup(html)).toContain('aria-hidden="true"');
  });

  test('ONE mark across both waiting windows — byte-identical with and without a workspace', () => {
    // This is the whole point of the component: the moment the create SUCCEEDS
    // must not be rendered as the waiting UI being torn down and replaced.
    // If these two ever diverge, the seam is visible again.
    const creating = markup(render({ workspaceName: 'x', workspaceId: null }));
    const onboarding = markup(render({ workspaceName: 'x', workspaceId: 'workspace-1' }));
    expect(creating).not.toBe('');
    expect(onboarding).toBe(creating);
  });

  test('the caption is the same string in both windows, so nothing flickers at the seam', () => {
    const creating = stripTags(render({ workspaceName: 'suna-web', workspaceId: null }));
    const onboarding = stripTags(render({ workspaceName: 'suna-web', workspaceId: 'workspace-1' }));
    expect(creating).toContain('Creating suna-web');
    expect(onboarding).toContain('Creating suna-web');
  });

  test('a reload of /new?onboarding=<id> has no name, and says something true instead', () => {
    // `state.name` is the form's own useState, so a reload arrives with it
    // empty. The workspace exists by then — this is always window 2.
    const html = render({ workspaceName: '', workspaceId: 'workspace-1' });
    const text = stripTags(html);
    expect(text).toContain('Opening your workspace');
    expect(text).not.toContain('Creating ');
  });

  test('NO escape hatch, in either state — this screen offers the mark and the caption, nothing else', () => {
    // There used to be a delayed "Go to workspace" link once `workspaceId`
    // existed. It is gone on purpose: the wizard is a fullscreen portal and
    // covers this screen as soon as `getWorkspaceDetail` settles, so the link
    // was an offer to leave at the exact moment the user is being taken
    // somewhere. Both states are asserted because the link was conditioned on
    // `workspaceId` — checking only the null case would not notice it coming
    // back.
    for (const html of [
      render({ workspaceName: 'x', workspaceId: null }),
      render({ workspaceName: 'x', workspaceId: 'workspace-1' }),
    ]) {
      expect(html).not.toContain('Go to workspace');
      expect(html).not.toContain('<a ');
    }
  });

  test('the caption lands one beat behind the mark, not with it', () => {
    const captionIn = source.match(/const CAPTION_IN = \{([^}]*)\}/)?.[1] ?? '';
    const delay = Number(captionIn.match(/delay:\s*([\d.]+)/)?.[1]);
    expect(delay).toBeGreaterThan(0);
    // Within the doctrine's stagger range — long enough to read as sequence,
    // short enough that it is not a second event.
    expect(delay).toBeLessThan(0.3);
  });

  test('the mark is the canonical Kortix logo, breathing rather than spinning', () => {
    expect(source).toContain("from '@/components/ui/kortix-logo'");
    expect(source).toContain('variant="icon"');
    expect(source).toContain('animate-pulse');
  });

  test('the pulse is gated on reduced motion, since Tailwind loops it forever', () => {
    // `globals.css` has no blanket prefers-reduced-motion rule, so an
    // ungated `animate-pulse` runs regardless of the preference.
    expect(source).toContain('animate-pulse motion-reduce:animate-none');
  });

  test('the caption carries the shimmer, the same busy treatment as a live session', () => {
    // `session-starting-loader.tsx` uses TextShimmer for the same job, so
    // "working on it" reads the same here as it does mid-session.
    expect(source).toContain("from '@/components/ui/text-shimmer'");
    const html = render({ workspaceName: 'suna-web', workspaceId: null });
    // TextShimmer paints the text with a moving gradient, so the glyphs
    // themselves are transparent — if this class is gone, the caption is
    // invisible, not merely unanimated.
    expect(html).toContain('bg-clip-text');
    expect(html).toContain('text-transparent');
  });

  test('BOTH captions get the shimmer — the fallback is not a plain-text special case', () => {
    // The empty-name branch only renders on a hard reload of
    // `/new?onboarding=<id>`, which is exactly why it is easy to leave
    // untreated: it never appears in the normal create flow.
    const named = render({ workspaceName: 'suna-web', workspaceId: null });
    const nameless = render({ workspaceName: '', workspaceId: 'workspace-1' });
    for (const html of [named, nameless]) {
      expect(html).toContain('bg-clip-text');
      expect(html).toContain('--spread:');
    }
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
    expect(render({ workspaceName: 'x', workspaceId: null })).toContain('translateY(4px)');
  });
});
