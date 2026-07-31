import type { KortixProject } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import ProjectCard from './project-card';

const noop = () => {};

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
        onRename={noop}
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

  test('the emoji tile keeps the card’s own well background', () => {
    // The card passes `bg-background` so the tile reads as a well in the card's
    // `bg-secondary/80` surface. Under the inline chalk that class was dead;
    // with the emoji it is the tile's actual fill, so it has to survive
    // tailwind-merge against the component's `bg-muted`.
    const tile = tileOf(render({ icon: '🐢' }));

    expect(tile).toContain('bg-background');
    expect(tile).not.toContain('bg-muted');
  });

  test('the tile is still the large one, beside the name', () => {
    // size="lg" is what makes the emoji legible at 40px; a silent drop to the
    // md default would shrink it with no test noticing.
    expect(tileOf(render({ icon: '🐢' }))).toContain('size-10');
    expect(render({ icon: '🐢' })).toContain('Turtle Shop');
  });
});
