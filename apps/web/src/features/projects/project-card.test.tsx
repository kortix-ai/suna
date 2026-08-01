import type { KortixProject } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import ProjectCard from './project-card';

const noop = () => {};

/** Source with comments stripped, so a comment describing a prop can never
 *  satisfy a test asserting the prop is actually passed. */
const code = readFileSync(fileURLToPath(new URL('./project-card.tsx', import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const BASE: KortixProject = {
  project_id: 'p1',
  account_id: 'a1',
  name: 'Turtle Shop',
  repo_url: 'https://github.com/kortix-ai/turtle-shop',
  default_branch: 'main',
  manifest_path: 'kortix.yaml',
  status: 'active',
  metadata: {},
  last_opened_at: null,
  created_at: '2026-07-30T10:00:00.000Z',
  updated_at: '2026-07-30T10:00:00.000Z',
};

/** `useTranslations('hardcodedUi')` needs the provider; the card reads no real
 *  copy this file asserts on, so empty messages plus a swallowed onError is
 *  enough (same shell as features/session/action-panel/mode-gate.test.tsx). */
const render = (project: Partial<KortixProject>) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
      <ProjectCard
        project={{ ...BASE, ...project }}
        onOpen={noop}
        onEdit={noop}
        onArchive={noop}
        archiving={false}
      />
    </NextIntlClientProvider>,
  );

/**
 * The avatar tile only — a balanced `<span>` scan rather than a regex, because
 * the emoji tile nests a span and a non-greedy `</span>` match would stop at
 * the inner one. Isolating the tile is what makes the assertions below mean
 * anything: the card also renders the project NAME, so a whole-markup
 * `toContain('T')` would pass with the tile blank.
 */
function tileOf(html: string): string {
  const start = html.indexOf('<span data-slot="entity-avatar"');
  if (start < 0) return '';
  let depth = 0;
  for (let i = start; i < html.length; i++) {
    if (html.startsWith('<span', i)) depth++;
    else if (html.startsWith('</span>', i)) {
      depth--;
      if (depth === 0) return html.slice(start, i + '</span>'.length);
    }
  }
  return '';
}

/** What a sighted user reads inside the tile. */
const tileTextOf = (html: string) => tileOf(html).replace(/<[^>]*>/g, '');

describe('ProjectCard — the project’s own icon', () => {
  test('a project that set an icon shows that icon on its card', () => {
    // The payoff of the whole feature: the emoji picked in the create modal has
    // to survive the round trip and land on the card in the /projects grid.
    expect(tileTextOf(render({ icon: '🐢' }))).toBe('🐢');
  });

  test('the card shows the project’s OWN icon, not a fixed one', () => {
    expect(tileTextOf(render({ icon: '🍕' }))).toBe('🍕');
    expect(tileTextOf(render({ icon: '🚀' }))).toBe('🚀');
  });

  test('a project with no icon still shows its initial, unchanged', () => {
    // `null` is what the API returns for every project created before the
    // feature, which is nearly all of them.
    expect(tileTextOf(render({ icon: null }))).toBe('T');
  });

  test('a response with no icon field at all still shows the initial', () => {
    // `icon` is optional on KortixProject, so a stale/cached payload omits it.
    expect(tileTextOf(render({}))).toBe('T');
  });

  test('the icon-less tile keeps its chalk colour', () => {
    // The emoji tile drops the inline chalk style. That must not leak into the
    // icon-less path, which is what nearly every card in the grid renders.
    expect(tileOf(render({ icon: null }))).toContain('background-color');
    expect(tileOf(render({ icon: '🐢' }))).not.toContain('background-color');
  });

  test('the emoji tile that ships is byte-for-byte this', () => {
    // The line above only checks the BACKGROUND declaration. Dropping just
    // `backgroundColor` from the emoji tile while keeping chalk's `color` and
    // `borderColor` passes it, and ships a saturated chalk border on the card
    // — an inline `border-color` beats `border-border/60`. This golden is what
    // sees it: `style=` appears nowhere, so any surviving chalk fragment fails.
    expect(tileOf(render({ icon: '🐢' }))).toBe(
      '<span data-slot="entity-avatar" class="inline-flex shrink-0 items-center justify-center font-semibold size-10 rounded-md border-0 bg-emoji-fill-green inset-ring-1 inset-ring-emoji-ring-green text-xl"><span aria-hidden="true" class="leading-none">🐢</span></span>',
    );
  });

  test('the emoji tile wears the tint its emoji earns', () => {
    // The card is the surface this whole treatment exists for: the tile stops
    // being a neutral well and becomes the picker's hovered-cell look at rest.
    // 🐢 is anchored to green (components/ui/emoji-tint.ts), so this also pins
    // that the CARD reads the anchor table and not something of its own.
    const tile = tileOf(render({ icon: '🐢' }));

    expect(tile).toContain('bg-emoji-fill-green');
    expect(tile).toContain('inset-ring-emoji-ring-green');
    expect(tile).toContain('inset-ring-1');
  });

  test('the card no longer passes a background that would kill the tint', () => {
    // `className` is last into EntityAvatar's cn(), so ANY fill the card passes
    // silently beats `bg-emoji-fill-*` and ships a ringed grey tile. The card
    // used to pass `bg-background`; under the inline chalk it was dead CSS
    // (an inline background-color wins), and under the tint it was the bug.
    // Checked in the MARKUP, not the source: that is where tailwind-merge's
    // answer is observable.
    const tile = tileOf(render({ icon: '🐢' }));

    expect(tile).not.toContain('bg-background');
    expect(tile).not.toContain('bg-muted');

    // …and the icon-less tile keeps rendering exactly the colour it always did,
    // which is the inline chalk and never that class.
    expect(tileOf(render({ icon: null }))).toContain('background-color:hsl(');
    expect(tileOf(render({ icon: null }))).not.toContain('bg-background');
  });

  test('two projects that picked different emoji do not share a tile', () => {
    // Guards every "contains" above against a tint pinned to one hue.
    expect(tileOf(render({ icon: '🐢' }))).toContain('bg-emoji-fill-green');
    expect(tileOf(render({ icon: '🔥' }))).toContain('bg-emoji-fill-amber');
    expect(tileOf(render({ icon: '💧' }))).toContain('bg-emoji-fill-blue');
  });

  test('the tile is still the large one, beside the name', () => {
    // size="lg" is what makes the emoji legible at 40px; a silent drop to the
    // md default would shrink it with no test noticing.
    expect(tileOf(render({ icon: '🐢' }))).toContain('size-10');
    expect(render({ icon: '🐢' })).toContain('Turtle Shop');
  });
});

describe('ProjectCard — the project’s own glyph', () => {
  test('a project that set a glyph shows that glyph on its card', () => {
    const tile = tileOf(render({ icon_glyph: { name: 'Rocket', color: 'magenta' } }));

    expect(tile).toContain('<svg');
    expect(tile).toContain('bg-glyph-fill-magenta');
    expect(tile).toContain('text-glyph-ring-magenta');
  });

  test('a project with no glyph and no icon still shows its initial', () => {
    expect(tileTextOf(render({ icon: null, icon_glyph: null }))).toBe('T');
  });

  test('a response with no glyph field at all still shows the initial', () => {
    // `icon_glyph` is optional on KortixProject, so a stale/cached payload
    // omits it — the same case `icon` already covers.
    expect(tileTextOf(render({}))).toBe('T');
  });

  test('the glyph is passed to EntityAvatar, which is what actually enforces precedence', () => {
    // The card's own job is just to hand both fields off — precedence between
    // a glyph, an emoji, an icon and the initial is EntityAvatar's contract,
    // covered by entity-avatar.test.tsx. This only pins that the card does not
    // quietly drop the prop, e.g. by passing `emoji` and forgetting `glyph`.
    expect(code).toContain('glyph={project.icon_glyph}');
    expect(code).toContain('emoji={project.icon}');
  });

  test('a glyph project does not also render the emoji tint', () => {
    const tile = tileOf(render({ icon_glyph: { name: 'Star', color: 'blue' } }));

    expect(tile.includes('emoji-fill-')).toBe(false);
  });
});
