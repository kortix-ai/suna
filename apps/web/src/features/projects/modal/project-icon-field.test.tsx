import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';

import { ProjectIconField } from './project-icon-field';

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const source = read('./project-icon-field.tsx');
const pickerSource = read('../../../components/ui/emoji-picker.tsx');
const popoverSource = read('../../../components/ui/popover.tsx');

/**
 * Source with comments stripped. Every "the code does X" check below reads
 * `code`, so a comment that merely describes X can never turn one green.
 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const render = (props: Parameters<typeof ProjectIconField>[0]) =>
  renderToStaticMarkup(<ProjectIconField {...props} />);

const noop = () => {};

/**
 * Compile-time pin on the props contract, checked by `tsc --noEmit` and not by
 * `bun test`. `strict` is on repo-wide, so `strictFunctionTypes` makes a prop
 * callback contravariant: widening `onChange` back to
 * `(icon: string | null) => void` makes the component NO LONGER assignable
 * here and the typecheck fails. The signature carried `| null` through a whole
 * round of review with 25 tests passing, so the source assertions in
 * 'the setter is narrower than the getter' carry the same rule for `bun test`.
 */
type PinnedProps = {
  value: string | null;
  onChange: (icon: string) => void;
  disabled?: boolean;
};
const signaturePin: (props: PinnedProps) => unknown = ProjectIconField;

describe('ProjectIconField trigger', () => {
  test('renders the selected emoji, and only it', () => {
    const html = render({ value: '🚀', onChange: noop });

    expect(html).toContain('🚀');
    // The fallback glyph is a Phosphor SVG. Both faces on screen at once means
    // the cross-fade has lost its shared box and they are stacked, not swapped.
    expect(html).not.toContain('<svg');
  });

  test('falls back to a neutral glyph when unset', () => {
    const html = render({ value: null, onChange: noop });

    expect(html).toContain('<svg');
  });

  test('names the control for assistive tech in both states', () => {
    // frimousse gives the trigger no visible text, so the aria-label is the
    // control's only accessible name.
    expect(render({ value: null, onChange: noop })).toContain('aria-label="Choose project icon"');
    expect(render({ value: '🚀', onChange: noop })).toContain(
      'aria-label="Project icon: 🚀. Change it"',
    );
  });

  test('keeps the glyph itself out of the accessibility tree', () => {
    // The button is already named by its aria-label. Without aria-hidden the
    // glyph is announced a second time, after the label that just described it.
    expect(render({ value: '🚀', onChange: noop })).toMatch(/aria-hidden="true"[^>]*>🚀/);
  });

  test('is type="button", declared here and not only inherited', () => {
    // The field renders inside the create modal's <form>. A <button> with no
    // type submits it, so opening the picker would create the project.
    //
    // Radix's PopoverTrigger merges its own type="button" into the asChild
    // element, so the rendered assertion alone cannot fail — verified by
    // deleting the prop and watching it stay green. Both layers are pinned:
    // the markup, which is what actually protects the form, and the source,
    // which is what stops the prop being dropped as redundant.
    expect(render({ value: null, onChange: noop })).toContain('type="button"');
    expect(code).toMatch(/<Button\s[\s\S]*?\btype="button"/);
  });

  test('disabled reaches the button element, not just the styling', () => {
    expect(render({ value: null, onChange: noop, disabled: true })).toContain('disabled=""');
    expect(render({ value: null, onChange: noop })).not.toContain('disabled=""');
  });

  test('the setter is narrower than the getter', () => {
    // The field can DISPLAY "no icon" — `value` is nullable — but it can never
    // PRODUCE one: the only onChange call site is the picker's onEmojiSelect,
    // which always has an emoji, and nothing here clears. `string | null` was a
    // promise the component never kept. Nothing clears because nothing needs to:
    // the trigger stays live, so you reopen it and switch. Resetting to `null`
    // on close is the modal's own state, not this field's.
    //
    // `signaturePin` is the real guard and only `tsc` can fail it; referencing
    // it here is not the assertion. These two are what `bun test` can see.
    expect(signaturePin).toBe(ProjectIconField);
    expect(code).toContain('onChange: (icon: string) => void;');
    expect(code).toContain('value: string | null;');
    expect(code).not.toMatch(/onChange:\s*\(icon: string \| null\)/);
  });

  test('disabling the field closes an open popover', () => {
    // The modal disables the row while it submits. Left as plain `open={open}`
    // the picker floats over a form that is already on its way out.
    expect(code).toMatch(/<Popover\s+open=\{open && !disabled\}/);
  });
});

/**
 * The popover has to be EXACTLY as wide as the emoji grid.
 *
 * A frimousse row is a bare flex line with no justification, so surplus width
 * lands as dead space on the right of every row and the grid stops lining up
 * with the full-width search field above it. Deficit width is worse: the cells
 * are `size-8` with the default `flex-shrink: 1`, so they silently stop being
 * square.
 *
 * The three inputs to that width live in three different files, and nothing
 * else ties them together.
 */
describe('ProjectIconField popover geometry', () => {
  /** `w-[calc(<track>*var(--spacing)+<border>px)]` on the PopoverContent. */
  const declared = code.match(/w-\[calc\((\d+(?:\.\d+)?)\*var\(--spacing\)\+(\d+)px\)\]/);

  /** frimousse's own default column count, read from the installed package. */
  const columns = Number(
    readFileSync(createRequire(import.meta.url).resolve('frimousse'), 'utf8').match(
      /columns\s*:\s*\w+\s*=\s*(\d+)/,
    )?.[1],
  );

  /** `size-<n>` on the emoji cell, in --spacing units. */
  const cell = Number(
    pickerSource
      .slice(pickerSource.indexOf('const EMOJI_BUTTON'))
      .match(/\bsize-(\d+(?:\.\d+)?)\b/)?.[1],
  );

  /** `px-<n>` on the row that holds the cells, in --spacing units. */
  const rowPadding = Number(pickerSource.match(/'group\/row flex px-(\d+(?:\.\d+)?)'/)?.[1]);

  test('the three inputs to the width were all readable', () => {
    // Guard the guards: every assertion below is vacuous if a regex silently
    // missed, and a NaN comparison fails in a way that reads like a real
    // geometry bug rather than a stale pattern.
    expect({ columns, cell, rowPadding }).toEqual({ columns: 9, cell: 8, rowPadding: 1.5 });
  });

  test('the popover is exactly as wide as the grid it contains', () => {
    expect(declared).not.toBeNull();
    expect(Number(declared?.[1])).toBe(columns * cell + 2 * rowPadding);
  });

  test('the width allows for the popover border on each side', () => {
    // PopoverContent is border-box, so its 1px border eats into the declared
    // width. Without the correction the grid is 2px short and the cells shrink.
    const classes = popoverSource.match(/'([^']*rounded-lg[^']*)'/)?.[1]?.split(/\s+/) ?? [];

    expect(classes).toContain('border');
    expect(classes.filter((c) => /^border-\d/.test(c))).toEqual([]);
    expect(Number(declared?.[2])).toBe(2);
  });

  test('the picker takes frimousse’s default column count', () => {
    // The width above is computed from the default. An explicit `columns` on
    // Frimousse.Root would silently make it wrong.
    expect(pickerSource).not.toMatch(/<Frimousse\.Root[\s\S]*?\bcolumns=/);
  });

  test('the popover cancels its own padding', () => {
    // PopoverContent defaults to p-4. The picker already pads itself (p-2
    // search, px-1.5 rows, px-2 footer), so the default insets it a second time.
    expect(code).toMatch(/<PopoverContent[\s\S]*?className="[^"]*\bp-0\b/);
  });

  test('the popover clips the picker to its own radius', () => {
    // The picker is a square-cornered flex column filling a rounded-lg surface.
    expect(code).toMatch(/<PopoverContent[\s\S]*?className="[^"]*\boverflow-hidden\b/);
  });
});

describe('ProjectIconField conventions', () => {
  test('the two faces cross-fade in a shared box instead of hard-swapping', () => {
    // Picking an emoji closes the popover, so the eye is on the trigger at the
    // exact moment it changes; a hard swap reads as two objects blinking. The
    // values are the ones the design system fixes for this: scale 0.25 -> 1,
    // opacity 0 -> 1, blur 4px -> 0.
    const swap = code.slice(code.indexOf('const SWAP = {'), code.indexOf('const SWAP_REDUCED'));

    expect(swap).toContain("initial: { scale: 0.25, opacity: 0, filter: 'blur(4px)' }");
    expect(swap).toContain("animate: { scale: 1, opacity: 1, filter: 'blur(0px)' }");
    expect(swap).toContain("exit: { scale: 0.25, opacity: 0, filter: 'blur(4px)' }");

    // Both faces need one shared, fixed box or they cross-fade in different
    // places and the button's width jumps mid-swap.
    expect(code).toMatch(/relative inline-flex size-\d/);
    expect(code.match(/absolute inset-0/g)).toHaveLength(1);
  });

  test('the swap spring is buttery, never bouncy', () => {
    expect(code).toContain("transition={{ type: 'spring', duration: 0.3, bounce: 0 }}");
  });

  test('a field that mounts with a value does not animate on first paint', () => {
    expect(code).toContain('<AnimatePresence initial={false}');
  });

  test('re-keys on the value so changing emoji animates too', () => {
    // Keyed on a constant, AnimatePresence sees one stable child and only the
    // null <-> set transition animates; picking a different emoji snaps.
    expect(code).toMatch(/key=\{value \?\? '[^']+'\}/);
  });

  test('reduced motion animates opacity only', () => {
    // motion/react runs the spring at full strength under
    // `prefers-reduced-motion: reduce` unless it is told not to — measured in
    // Chromium with emulateMedia({ reducedMotion: 'reduce' }) before this
    // branch existed. Opacity stays: it is what says the face changed.
    expect(code).toMatch(/reduceMotion\s*=\s*useReducedMotion\(\)/);
    expect(code).toContain('{...(reduceMotion ? SWAP_REDUCED : SWAP)}');

    // Only opacity may differ from the resting state, or something other than
    // the cross-fade is still moving.
    expect(code).toContain('initial: { ...SWAP.animate, opacity: 0 }');
    expect(code).toContain('exit: { ...SWAP.animate, opacity: 0 }');
  });

  test('both motion variants rest in exactly the same state', () => {
    // The server cannot know the preference, so it always renders the full
    // variant's resting style. A hand-written resting state here made the
    // client hydrate `opacity: 1` over a server-rendered
    // `opacity: 1; filter: blur(0px); transform: none` — a React hydration
    // mismatch it says it will not patch up. Reusing the object is what pins it.
    expect(code).toContain('animate: SWAP.animate,');
  });

  test('the press feedback is the codebase scale, not a smaller one', () => {
    // Below 0.95 the press reads as exaggerated.
    expect(code).toContain('active:scale-[0.96]');
  });

  test('the trigger carries a pointer target of at least 40px', () => {
    // The visible control is size-9 (33.11px) because it has to line up with
    // the sibling name Input. hit-area-1 pads the target to 40.47px without
    // moving a pixel, using the repo's own utility (see globals.css).
    expect(code).toMatch(/className="[^"]*\bhit-area-1\b[^"]*\bsize-9\b/);
  });

  test('the two faces share a box the wider of them actually fits', () => {
    // A text-lg emoji measures 21px. size-5 is 18.39px, so the glyph hung
    // 2.61px out of the box the cross-fade scales and blurs within.
    expect(code).toMatch(/relative inline-flex size-6 items-center justify-center/);
  });

  test('names exact transition properties, never all', () => {
    expect(code).not.toMatch(/transition-all|transition:\s*all/);
  });

  test('uses no icon as a spinner', () => {
    expect(code).not.toMatch(/animate-spin\b/);
    expect(code).not.toMatch(/CircleNotch|SpinnerGap|SpinnerIcon/);
  });

  test('uses no raw palette colour', () => {
    expect(code).not.toMatch(/\b(?:bg|text|border)-(?:red|blue|green|amber|slate|zinc|gray)-\d/);
    expect(code).not.toMatch(/\b(?:bg|text|border)-\[(?:hsl|rgb|oklch|#)/);
  });
});
