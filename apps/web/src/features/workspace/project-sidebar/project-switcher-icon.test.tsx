import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import { stripTags } from '@/test-utils/strip-tags';
import { EntityAvatar } from '../../../components/ui/entity-avatar';

/**
 * The project switcher's list rows show each project's own icon.
 *
 * Without it a user picks 🐢 in the create modal, sees it on the card in
 * /projects, opens the project, and the switcher beside the name shows "T" —
 * the feature visible on one of the two surfaces that render a project's
 * identity.
 *
 * SPLIT INTO TWO LINKS, because the component itself cannot be rendered here.
 * `WorkspaceSwitcher` needs a router, three react-query caches and two zustand
 * stores, and its list lives inside a `DropdownMenuContent` that renders
 * nothing while the menu is closed — which it always is on a first paint. The
 * alternative, `mock.module`-ing next/navigation and @kortix/sdk, is
 * process-wide in `bun test src` and would leak into the other 293 files.
 *
 *   1. the source scan below pins the exact props the row hands EntityAvatar;
 *   2. the render below pins what EntityAvatar does with those exact props.
 *
 * Neither half is worth much alone. Together they cover the whole path.
 */
const source = readFileSync(join(import.meta.dir, 'workspace-switcher.tsx'), 'utf8');

/** Source with comments stripped, so prose about a prop cannot stand in for it. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const mapStart = code.indexOf('group.workspaces.map(');
const rowJsx =
  mapStart < 0 ? '' : code.slice(mapStart, code.indexOf('</DropdownMenuItem>', mapStart));

/** Every self-closing `<EntityAvatar …/>` in the file, in source order. */
const avatars = code.match(/<EntityAvatar[^/]*\/>/g) ?? [];
const rowAvatar = rowJsx.match(/<EntityAvatar[^/]*\/>/)?.[0] ?? '';

describe('project switcher: the row the source renders', () => {
  test('the scan actually found the list row', () => {
    // Guard the guards: every assertion below is a substring check on
    // `rowAvatar`, and `''.toContain(…)` fails loudly while `''.not.toContain(…)`
    // passes silently. A renamed `group.workspaces` would otherwise make half
    // this file vacuous rather than red.
    expect(mapStart).toBeGreaterThan(-1);
    expect(rowAvatar).toMatch(/^<EntityAvatar\b/);
  });

  test('each row shows the icon of the project THAT row is rendering', () => {
    // `workspace` is the map's own parameter, so this is per-row by construction.
    // Reading anything else — the active project's icon, a constant — would
    // paint every row the same.
    expect(rowAvatar).toContain('emoji={workspace.icon}');
    expect(rowAvatar).toContain('label={workspace.name}');
  });

  test('the row is the only tile in this file that took an emoji', () => {
    // The switcher renders three EntityAvatars: the active-project tile, its
    // no-project fallback, and this row. The trigger tile (`switcherLabel`) is
    // DELIBERATELY untouched — it is fed a plain string resolved from the
    // project name, with no `KortixProject` in scope, so wiring it needs real
    // plumbing and is a separate change. This pins that, and it also fails on
    // the tempting wrong fix: passing `emoji={switcherLabel}` would render the
    // project's first letter as an "emoji" and drop the tile's chalk fill.
    expect(avatars).toHaveLength(3);
    expect(avatars.filter((avatar) => avatar.includes('emoji='))).toEqual([rowAvatar]);
  });

  test('the row tile stays at the size the emoji was measured for', () => {
    // Measured painted extent vs. tile: `sm` is 18x16 in a 22.08px box (0.82).
    // `xs` is 16x14 in 18.40px — 0.976 of the content box, i.e. the glyph
    // effectively fills the tile edge to edge. The header variant of this
    // switcher uses `xs`; if the row ever adopts it, the emoji has to be
    // re-measured first.
    expect(rowAvatar).toContain('size="sm"');
    expect(rowAvatar).not.toContain('size="xs"');
  });
});

describe('project switcher: what those props render', () => {
  /** Exactly the call the row makes, against the two shapes `icon` takes. */
  const rowTile = (project: { name: string; icon?: string | null }) =>
    renderToStaticMarkup(<EntityAvatar label={project.name} emoji={project.icon} size="sm" />);

  const textOf = (html: string) => stripTags(html);

  test('a project with an icon shows that icon, not its initial', () => {
    expect(textOf(rowTile({ name: 'Turtle Shop', icon: '🐢' }))).toBe('🐢');
    expect(textOf(rowTile({ name: 'Turtle Shop', icon: '🍕' }))).toBe('🍕');
  });

  test('a project with no icon is unchanged — which is nearly every project', () => {
    // `null` is what the API returns for everything created before the feature,
    // and `undefined` is what a stale cached payload has, since `icon` is
    // optional on KortixProject.
    expect(textOf(rowTile({ name: 'Turtle Shop', icon: null }))).toBe('T');
    expect(textOf(rowTile({ name: 'Turtle Shop' }))).toBe('T');
  });

  test('the sm tile is the 22px square the measurement was taken in', () => {
    // Ties the `size="sm"` asserted above to the geometry it was chosen for: a
    // size-6 box with the emoji on its own text step, not the initial's.
    const tile = rowTile({ name: 'Turtle Shop', icon: '🐢' });

    expect(tile).toContain('size-6');
    expect(tile).toContain('text-sm');
  });
});
