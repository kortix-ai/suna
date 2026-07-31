import { RocketIcon } from '@phosphor-icons/react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { EntityAvatar, type EntityAvatarSize } from './entity-avatar';

const render = (props: Parameters<typeof EntityAvatar>[0]) =>
  renderToStaticMarkup(<EntityAvatar {...props} />);

/**
 * The tile's visible text, markup stripped. An icon is an `<svg>` and a nested
 * emoji span is a tag, so this is exactly "the characters a sighted user reads
 * inside the square" — which is the thing precedence decides. Asserting on the
 * WHOLE text with `toBe` (rather than `toContain`) is what makes a test fail
 * when two faces render at once instead of one replacing the other.
 */
const textOf = (html: string) => html.replace(/<[^>]*>/g, '');

/** The class list on the tile itself. The outer span is the first element in
 *  the markup, so a non-global match cannot pick up the inner emoji span. */
const classesOf = (html: string) => html.match(/class="([^"]*)"/)?.[1]?.split(/\s+/) ?? [];

const SIZES: EntityAvatarSize[] = ['xs', 'sm', 'md', 'lg', 'xl'];

/** The text size the tile has always used for the initial. Pinned so the emoji
 *  work cannot silently resize the letter every other caller renders. */
const INITIAL_TEXT: Record<EntityAvatarSize, string> = {
  xs: 'text-xs',
  sm: 'text-xs',
  md: 'text-xs',
  lg: 'text-sm',
  xl: 'text-base',
};

/**
 * The emoji's own size — its own step on the scale, not the initial's. Without
 * it the emoji inherits the INITIAL's size and the 36.8px `lg` card tile
 * renders a 14px emoji: legible, but visibly a letter-sized thing in an
 * icon-sized hole. The values are measured painted extents; the rationale and
 * the numbers live on SIZE_MAP in entity-avatar.tsx.
 */
const EMOJI_TEXT: Record<EntityAvatarSize, string> = {
  xs: 'text-xs',
  sm: 'text-sm',
  md: 'text-base',
  lg: 'text-xl',
  xl: 'text-3xl',
};

describe('EntityAvatar — what the tile shows', () => {
  test('renders the emoji, and only the emoji', () => {
    expect(textOf(render({ label: 'Demo', emoji: '🚀' }))).toBe('🚀');
  });

  test('falls back to the label’s initial when no emoji is given', () => {
    const html = render({ label: 'Demo' });

    expect(textOf(html)).toBe('D');
    expect(html).not.toContain('🚀');
  });

  test('precedence is emoji, then icon, then initial', () => {
    // Three cases in one test on purpose: written as three separate ones it is
    // easy for all three to pass while the component only ever renders the
    // right thing by accident. Each row here fixes what the OTHER two inputs
    // are, so the only thing that can satisfy it is the ordering itself.
    const all = render({ label: 'Demo', emoji: '🚀', icon: RocketIcon });
    expect(textOf(all)).toBe('🚀');
    expect(all).not.toContain('<svg');

    const iconAndInitial = render({ label: 'Demo', icon: RocketIcon });
    expect(textOf(iconAndInitial)).toBe('');
    expect(iconAndInitial).toContain('<svg');

    const initialOnly = render({ label: 'Demo' });
    expect(textOf(initialOnly)).toBe('D');
    expect(initialOnly).not.toContain('<svg');
  });

  test('the emoji beats an icon component', () => {
    // The icon branch is the one an `emoji ? … : IconComponent ? …` chain gets
    // wrong when the two are swapped: with the icon checked first, every
    // marketplace/account tile that passes BOTH would keep showing the icon
    // and the project emoji would never appear.
    const html = render({ label: 'Demo', icon: RocketIcon, emoji: '🚀' });

    expect(html).toContain('🚀');
    expect(html).not.toContain('<svg');
  });

  test('the emoji beats the initial', () => {
    // `Demo` initials to `D`. The tile's whole text has to be the emoji: a
    // component that renders both would still contain the emoji.
    expect(textOf(render({ label: 'Demo', emoji: '🚀' }))).not.toContain('D');
  });

  test('null — what the SDK returns for "no icon" — falls through to the initial', () => {
    // `KortixProject.icon` is `string | null | undefined`, so the prop takes
    // null and the card passes it straight through. A truthiness check is what
    // makes this work; `emoji !== undefined` would render an empty span here
    // and the initial would vanish for every project that never set an icon.
    expect(textOf(render({ label: 'Demo', emoji: null }))).toBe('D');
  });

  test('an empty string is not an emoji', () => {
    expect(textOf(render({ label: 'Demo', emoji: '' }))).toBe('D');
  });

  test('keeps the glyph out of the accessibility tree', () => {
    // The tile always sits beside the name it belongs to (project card, account
    // row). Left announceable, a screen reader reads the emoji's CLDR name —
    // "rocket" — immediately before the label that names the same thing. Same
    // treatment as the picker trigger in features/projects/modal.
    expect(render({ label: 'Demo', emoji: '🚀' })).toMatch(/aria-hidden="true"[^>]*>🚀/);
  });
});

describe('EntityAvatar — the emoji tile’s surface', () => {
  test('drops the hash-derived chalk fill when an emoji is set', () => {
    // chalkColors() is applied as an inline style, so it beats any class a
    // caller passes. An emoji is already the colour; sitting it on a saturated
    // hash-derived pastel reads as noise, and in dark mode the pastel is a
    // bright square in an otherwise dark grid.
    expect(render({ label: 'Demo' })).toContain('background-color');
    expect(render({ label: 'Demo', emoji: '🚀' })).not.toContain('background-color');
  });

  test('keeps the chalk fill for the icon tile', () => {
    // The icon branch is monochrome and needs the chalk to read as an entity
    // tile at all. Dropping the style for every branch is the obvious slip.
    expect(render({ label: 'Demo', icon: RocketIcon })).toContain('background-color');
  });

  test('an emoji sits on a neutral fill', () => {
    // The fill only. The tile's EDGE is a separate decision with its own test
    // ('the emoji tile carries the hairline lift') — they were one assertion
    // while the border was `border-border/60`, and merging them again would
    // let a change to either hide behind the other.
    expect(classesOf(render({ label: 'Demo', emoji: '🚀' }))).toContain('bg-muted');

    // …and the initial tile must not pick it up, or the chalk background it
    // still sets inline would be fighting a class it never wanted.
    expect(classesOf(render({ label: 'Demo' }))).not.toContain('bg-muted');
  });

  test('a caller’s own background still wins over the neutral tile', () => {
    // The project card passes `bg-background` so the tile reads as a well in
    // the card's `bg-secondary/80` surface. `className` is last into cn(), so
    // tailwind-merge has to resolve it over the component's `bg-muted`.
    const classes = classesOf(render({ label: 'Demo', emoji: '🚀', className: 'bg-background' }));

    expect(classes).toContain('bg-background');
    expect(classes).not.toContain('bg-muted');
  });

  test('the emoji tile is still an entity-avatar slot', () => {
    expect(render({ label: 'Demo', emoji: '🚀' })).toContain('data-slot="entity-avatar"');
  });

  /**
   * The whole emoji tile, byte for byte.
   *
   * `not.toContain('background-color')` above is a substring check on ONE of
   * the three declarations chalkColors() writes. A mutant that drops only
   * `backgroundColor` and keeps `color` and `borderColor` satisfies it — and
   * satisfied all 27 tests in this task when it was tried. What it ships is a
   * saturated chalk BORDER on the emoji tile, because an inline `border-color`
   * beats the `border-border/60` class: measured `rgb(132, 210, 208)` where
   * `oklab(0.262899 … / 0.6)` was intended. That is precisely the noise the
   * style-drop exists to prevent, so the substring check cannot be the only
   * guard.
   *
   * A golden has no such blind spot. React omits the attribute entirely for a
   * `style` of `undefined`, so `style=` appears nowhere below — and ANY
   * surviving fragment of the chalk object puts it back.
   */
  const EMOJI_TILE =
    '<span data-slot="entity-avatar" class="inline-flex shrink-0 items-center justify-center border font-semibold size-8 rounded-md bg-muted border-foreground/25 shadow-2xs text-base"><span aria-hidden="true" class="leading-none">🚀</span></span>';

  /** The same, for the exact call shape the project card uses. */
  const EMOJI_CARD_TILE =
    '<span data-slot="entity-avatar" class="inline-flex shrink-0 items-center justify-center border font-semibold size-10 rounded-md border-foreground/25 shadow-2xs text-xl bg-background"><span aria-hidden="true" class="leading-none">🚀</span></span>';

  test('the emoji tile drops the WHOLE chalk object, not just its background', () => {
    expect(render({ label: 'Demo', emoji: '🚀' })).toBe(EMOJI_TILE);
    expect(render({ label: 'Demo', emoji: '🚀' })).not.toContain('style=');
  });

  test('the card’s emoji tile is byte-identical too', () => {
    expect(render({ label: 'Demo', emoji: '🚀', size: 'lg', className: 'bg-background' })).toBe(
      EMOJI_CARD_TILE,
    );
  });

  test('the emoji tile carries the hairline lift, in one token pair', () => {
    // Named separately from the goldens so a future re-generation of those
    // strings cannot quietly drop the lift and still look "regenerated".
    //
    // `border-foreground/25`, not `border-border/*`: dropping the chalk left
    // the tile with a 1.07:1 edge against the card in dark (1.09:1 light), and
    // full-strength `border-border` measures 1.06:1 there — that token is tuned
    // to sit on `--background`, while the card is `bg-secondary/80`, LIGHTER
    // than the tile's own fill in dark. `--foreground` inverts with the theme,
    // so 25% gives 1.73:1 dark / 1.58:1 light off one value and no `dark:`
    // variant.
    const classes = classesOf(render({ label: 'Demo', emoji: '🚀' }));

    expect(classes).toContain('border-foreground/25');
    expect(classes).toContain('shadow-2xs');
    expect(classes).not.toContain('border-border/60');

    // …and none of it may leak onto the tiles that still carry inline chalk,
    // where a shadow would sit under a saturated pastel and read as grime.
    for (const plain of [render({ label: 'Demo' }), render({ label: 'Demo', icon: RocketIcon })]) {
      expect(classesOf(plain)).not.toContain('shadow-2xs');
      expect(classesOf(plain)).not.toContain('border-foreground/25');
    }
  });
});

describe('EntityAvatar — sizing', () => {
  test('the initial keeps the text size it has always had', () => {
    for (const size of SIZES) {
      expect(classesOf(render({ label: 'Demo', size }))).toContain(INITIAL_TEXT[size]);
    }
  });

  test('the emoji is sized to the tile’s icon slot, not to the initial', () => {
    for (const size of SIZES) {
      const classes = classesOf(render({ label: 'Demo', emoji: '🚀', size }));

      expect(classes).toContain(EMOJI_TEXT[size]);

      // Where the two differ, the initial's size must be GONE — not merely
      // followed. Both land in tailwind-merge's font-size group, so ordering
      // inside cn() decides the winner: put the emoji size before `sizes.box`
      // and the tile silently keeps the letter size while this class list still
      // reads as if it had both.
      if (EMOJI_TEXT[size] !== INITIAL_TEXT[size]) {
        expect(classes).not.toContain(INITIAL_TEXT[size]);
      }
    }
  });

  test('every size renders a distinct emoji size — the map is not one value', () => {
    // Guards the guard above: a map that collapsed to a single class would
    // satisfy every row of it while making the tile's geometry wrong at four
    // of the five sizes.
    expect(new Set(Object.values(EMOJI_TEXT)).size).toBe(5);
  });
});

describe('EntityAvatar — existing callers', () => {
  /**
   * Captured from the component as it stood BEFORE `emoji` existed
   * (`git show HEAD:apps/web/src/components/ui/entity-avatar.tsx`, rendered
   * under this same harness) — attribute order, class order, inline chalk and
   * all.
   *
   * SCOPE: these two goldens pin the INITIAL branch, at the default size and at
   * the card's `lg` + className shape. They do not cover the ICON branch, which
   * is roughly 18–21 of the ~30 call sites: changing `sizes.icon`, or swapping
   * it for a text class, leaves every test in this file green. That code is
   * untouched by the emoji work, so it is a coverage gap rather than a
   * regression risk here — but do not read these as a byte-guarantee for every
   * caller.
   */
  const LEGACY_INITIAL_TILE =
    '<span data-slot="entity-avatar" style="background-color:hsl(179 46% 79%);color:hsl(179 56% 27%);border-color:hsl(179 46% 67%)" class="inline-flex shrink-0 items-center justify-center border font-semibold size-8 rounded-md text-xs">D</span>';

  /** The same, for the one call shape the project card uses today. */
  const LEGACY_CARD_TILE =
    '<span data-slot="entity-avatar" style="background-color:hsl(179 46% 79%);color:hsl(179 56% 27%);border-color:hsl(179 46% 67%)" class="inline-flex shrink-0 items-center justify-center border font-semibold size-10 rounded-md text-sm bg-background">D</span>';

  test('an emoji-less tile is byte-identical to the pre-emoji component', () => {
    expect(render({ label: 'Demo' })).toBe(LEGACY_INITIAL_TILE);
  });

  test('every falsy emoji is byte-identical too, chalk seed included', () => {
    // `toBe` on the whole tile is what makes this bite. Seeding chalkColors()
    // with the emoji — `chalkColors(emoji ?? label)` — is invisible for a SET
    // emoji, because that tile drops the inline style altogether; it only shows
    // up here, where `''` reaches the seed and re-colours a tile that is still
    // rendering its initial. Caught as a surviving mutant with the text-only
    // assertion below it.
    for (const emoji of [null, undefined, '']) {
      expect(render({ label: 'Demo', emoji })).toBe(LEGACY_INITIAL_TILE);
    }
  });

  test('an emoji-less tile with a caller className is byte-identical too', () => {
    expect(render({ label: 'Demo', size: 'lg', className: 'bg-background' })).toBe(
      LEGACY_CARD_TILE,
    );
  });

  /**
   * The ICON branch, which the two goldens above do not reach and which is
   * roughly 18–21 of the ~30 call sites. Before this, changing `sizes.icon` —
   * or swapping it for a text class — left the whole suite green.
   *
   * Path data is stripped: it belongs to Phosphor, and a version bump would
   * break a full-byte golden for a reason that has nothing to do with this
   * component. Everything this file actually owns — the tile's classes, the
   * inline chalk, and the size class handed to the icon — is still pinned.
   */
  const withoutPathData = (html: string) => html.replace(/<path\b[^>]*><\/path>/g, '<path/>');

  const LEGACY_ICON_TILE =
    '<span data-slot="entity-avatar" style="background-color:hsl(179 46% 79%);color:hsl(179 56% 27%);border-color:hsl(179 46% 67%)" class="inline-flex shrink-0 items-center justify-center border font-semibold size-8 rounded-md text-xs"><svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" fill="currentColor" viewBox="0 0 256 256" class="size-4"><path/></svg></span>';

  /** The icon slot per tile size — the other half of SIZE_MAP's geometry. */
  const ICON_SIZE: Record<EntityAvatarSize, string> = {
    xs: 'size-3',
    sm: 'size-3.5',
    md: 'size-4',
    lg: 'size-5',
    xl: 'size-7',
  };

  test('an icon tile is byte-identical, chalk and icon size included', () => {
    expect(withoutPathData(render({ label: 'Demo', icon: RocketIcon }))).toBe(LEGACY_ICON_TILE);
  });

  test('every size hands the icon its own dimension', () => {
    for (const size of SIZES) {
      const svg = render({ label: 'Demo', icon: RocketIcon, size }).match(/<svg[^>]*>/)?.[0] ?? '';
      expect(svg).toContain(`class="${ICON_SIZE[size]}"`);
    }
    // A map collapsed to one value would satisfy the loop at exactly one size
    // and silently mis-size the other four.
    expect(new Set(Object.values(ICON_SIZE)).size).toBe(5);
  });

  test('a label-less tile still falls back the way it always has', () => {
    // `label` is optional on this component and several call sites pass only an
    // icon. The `?` fallback is the pre-existing behaviour for neither.
    expect(textOf(render({}))).toBe('?');
    expect(textOf(render({ emoji: '🚀' }))).toBe('🚀');
  });
});
