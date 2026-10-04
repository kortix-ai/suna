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
    const html = render({ workspaceName: 'suna-web' });
    expect(html).toContain('role="status"');
    // Explicit alongside the role, for ATs that do not map role=status to a
    // polite live region.
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-busy="true"');
    expect(stripTags(html)).toContain('Creating suna-web');
  });

  test('the mark is decoration — hidden from the accessibility tree', () => {
    const html = render({ workspaceName: 'x' });
    expect(markup(html)).toContain('aria-hidden="true"');
  });

  test('an empty name says something true instead of "Creating "', () => {
    // The create gate requires a name, so the normal flow never renders this
    // branch — but the component takes any string, and a bare "Creating "
    // would be a lie.
    const html = render({ workspaceName: '' });
    const text = stripTags(html);
    expect(text).toContain('Opening your workspace');
    expect(text).not.toContain('Creating ');
  });

  test('NO escape hatch — this screen offers the mark and the caption, nothing else', () => {
    // There used to be a delayed "Go to workspace" link. It is gone on
    // purpose: the handoff holds the page only while the create is in flight,
    // and the orchestration navigates on success, so a link would offer to
    // leave at the exact moment the user is being taken somewhere.
    const html = render({ workspaceName: 'x' });
    expect(html).not.toContain('Go to workspace');
    expect(html).not.toContain('<a ');
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
    const html = render({ workspaceName: 'suna-web' });
    // TextShimmer paints the text with a moving gradient, so the glyphs
    // themselves are transparent — if this class is gone, the caption is
    // invisible, not merely unanimated.
    expect(html).toContain('bg-clip-text');
    expect(html).toContain('text-transparent');
  });

  test('BOTH captions get the shimmer — the fallback is not a plain-text special case', () => {
    // The empty-name branch only renders off the normal flow, which is
    // exactly why it is easy to leave untreated: it never appears in the
    // normal create flow.
    const named = render({ workspaceName: 'suna-web' });
    const nameless = render({ workspaceName: '' });
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
    expect(render({ workspaceName: 'x' })).toContain('translateY(4px)');
  });
});
