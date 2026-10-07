import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ProvisionPhase } from '@kortix/sdk';

import { stripTags } from '@/test-utils/strip-tags';
import { HANDOFF_STEPS, WorkspaceHandoff } from './workspace-handoff';

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

/**
 * The streamed provisioning steps (KRTX-1543).
 *
 * The managed create reports its progress live over `POST
 * /projects/provision-stream` — four phases, emitted by `runProvision`
 * (`apps/api/src/projects/provision-core.ts`) in a fixed order. The handoff
 * used to hold the page with one opaque shimmer for the whole wait; now the
 * steps the server reports render as they arrive. An absent or unknown phase
 * (GitHub sources, the plain-POST fallback, a newer server) must render
 * exactly the base screen — no invented progress.
 */
describe('WorkspaceHandoff: the streamed provisioning steps', () => {
  test('the four server steps render, in the order the server emits them', () => {
    const html = render({ workspaceName: 'suna-web', phase: 'registering' });
    const text = stripTags(html);
    const validating = text.indexOf('Validating');
    const creating = text.indexOf('Creating repository');
    const registering = text.indexOf('Registering workspace');
    const seeding = text.indexOf('Seeding starter files');
    // Every label present, each strictly after the one before it — the order
    // is the server's, not an alphabetical or cosmetic one.
    for (const at of [validating, creating, registering, seeding]) expect(at).toBeGreaterThan(-1);
    expect(validating).toBeLessThan(creating);
    expect(creating).toBeLessThan(registering);
    expect(registering).toBeLessThan(seeding);
  });

  test('the step in progress is aria-current="step"; no other row is', () => {
    const html = render({ workspaceName: 'suna-web', phase: 'registering' });
    expect(html).toContain('aria-current="step"');
    // Exactly one current step out of four rows.
    expect(html.split('aria-current="step"').length - 1).toBe(1);
  });

  test('finished steps carry the completed glyph, the running step the in-progress ring, the future ones the pending dots', () => {
    const html = render({ workspaceName: 'suna-web', phase: 'registering' });
    // The glyphs are the session todo list's own `TodoStatusIcon` states:
    // completed -> the green knockout disc, in_progress -> the orange ring
    // spinner, pending -> the dashed circle.
    expect(html.split('text-kortix-green').length - 1).toBe(2);
    expect(html).toContain('text-kortix-orange');
    expect(html).toContain('animate-spinner-orbit');
    expect(html.split('stroke-dasharray').length - 1).toBe(1);
  });

  test('the step in progress keeps the caption shimmer; the finished steps do not shimmer', () => {
    // The caption stays the headline ("Creating suna-web" is still true);
    // only the CURRENT step gets the app's one spinner, so the shimmer
    // treatment must not leak onto the finished or future rows.
    const html = render({ workspaceName: 'suna-web', phase: 'validating' });
    expect(html).toContain('Creating suna-web');
    expect(html.split('bg-clip-text').length - 1).toBe(1);
  });

  test('the steps render inside the existing single status region — no second live region', () => {
    const html = render({ workspaceName: 'suna-web', phase: 'creating_repository' });
    const region = html.indexOf('role="status"');
    const list = html.indexOf('<ol');
    expect(region).toBeGreaterThan(-1);
    expect(list).toBeGreaterThan(region);
    // One status region for the whole handoff, as before.
    expect(html.split('role="status"').length - 1).toBe(1);
  });

  test('an unknown phase from a newer server renders exactly the base screen', () => {
    // The wire is JSON — an older client CAN receive a phase name it does not
    // know. Inventing a row for it (or crashing) would be worse than the base
    // screen; the cast names the exact wire shape this guards.
    const html = render({
      workspaceName: 'suna-web',
      phase: 'fabricating' as ProvisionPhase,
    });
    expect(html).not.toContain('<ol');
    expect(html).not.toContain('aria-current');
    expect(stripTags(html)).toContain('Creating suna-web');
  });

  test('an absent phase (GitHub sources, plain-POST fallback) renders exactly the base screen', () => {
    for (const phase of [undefined, null] as const) {
      const html = render({ workspaceName: 'suna-web', phase });
      expect(html).not.toContain('<ol');
      expect(html).not.toContain('aria-current');
      expect(stripTags(html)).toContain('Creating suna-web');
    }
  });

  test('the step list mirrors the SDK ProvisionPhase union exactly, in the server order', () => {
    // `PROVISION_PHASES` (apps/api/src/projects/provision-core.ts:82) is the
    // emission order; the SDK union mirrors it byte-identically. A step added
    // server-side must appear here in the right slot or the list silently
    // stops advancing.
    const exhaustive: Record<ProvisionPhase, true> = {
      validating: true,
      creating_repository: true,
      registering: true,
      seeding: true,
    };
    expect(Object.keys(exhaustive).sort()).toEqual([...HANDOFF_STEPS].sort());
    expect([...HANDOFF_STEPS]).toEqual([
      'validating',
      'creating_repository',
      'registering',
      'seeding',
    ]);
  });

  test('every step label exists in all nine catalogs', () => {
    for (const locale of ['de', 'en', 'es', 'fr', 'it', 'ja', 'pt', 'sr', 'zh'] as const) {
      const catalog = JSON.parse(
        readFileSync(join(import.meta.dir, `../../../../translations/${locale}.json`), 'utf8'),
      ) as { newWorkspace?: { handoff?: Record<string, string> } };
      const handoff = catalog.newWorkspace?.handoff;
      if (!handoff) throw new Error(`${locale}: missing newWorkspace.handoff`);
      for (const step of HANDOFF_STEPS) {
        const label = handoff[step];
        if (typeof label !== 'string' || label.length === 0) {
          throw new Error(`${locale}: empty or missing handoff label for ${step}`);
        }
      }
    }
  });
});
