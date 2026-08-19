import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';

import { EntityAvatar } from '@/components/ui/entity-avatar';
import type { GlyphSelection } from '@/components/ui/glyph-picker';
import { FLOATING_PANEL } from '@/components/ui/menu-recipe';

import { ProjectIconField, type ProjectIconValue } from './project-icon-field';

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const source = read('./project-icon-field.tsx');
const pickerSource = read('../../../components/ui/emoji-picker.tsx');
const buttonSource = read('../../../components/ui/button.tsx');

/**
 * Source with comments stripped. Every "the code does X" check below reads
 * `code`, so a comment that merely describes X can never turn one green.
 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const noop = () => {};

/** `onChange`/`onGlyphChange` default to no-ops so most call sites only ever
 *  spell out the one prop the test is actually about. */
const render = (
  props: Partial<Parameters<typeof ProjectIconField>[0]> & { value: ProjectIconValue },
) => renderToStaticMarkup(<ProjectIconField onChange={noop} onGlyphChange={noop} {...props} />);

/** A renderable glyph, used everywhere a test needs "some glyph is picked". */
const ROCKET_BLUE: GlyphSelection = { name: 'Rocket', color: 'blue' };

/**
 * Compile-time pin on the props contract, checked by `tsc --noEmit` and not by
 * `bun test`. `strict` is on repo-wide, so `strictFunctionTypes` makes a prop
 * callback contravariant: widening `onChange` back to
 * `(icon: string | null) => void`, or widening `value` past the union, makes
 * the component NO LONGER assignable here and the typecheck fails.
 *
 * `value` is a UNION (`{ emoji } | { glyph } | null`), not two independently
 * nullable slots — that is what makes it impossible for a host to hold, and
 * therefore send, both an emoji AND a glyph at once. `onChange` and
 * `onGlyphChange` are two narrow setters rather than one
 * `(value: ProjectIconValue) => void`: one wide callback would overload a
 * single signature with three different events and force every host to
 * re-derive which one happened from the argument.
 *
 * `onClear` was added when the edit modal needed a way to take an existing
 * project's icon back off, and it did NOT weaken the rule above — that is the
 * point of it being a third callback rather than a nullable `onChange`.
 * Removing and picking are different events; one nullable setter would make
 * every host re-derive which one happened, and would hand the create modal a
 * clear channel it has no use for.
 *
 * The pin is declared with `onClear` present, not omitted. An optional member
 * left out of `PinnedProps` would still be assignable — the pin would simply
 * stop describing the real contract, and a later change to `onClear`'s shape
 * would go unnoticed here.
 */
type PinnedProps = {
  value: { emoji: string } | { glyph: GlyphSelection } | null;
  onChange: (icon: string) => void;
  onGlyphChange: (glyph: GlyphSelection) => void;
  onClear?: () => void;
  disabled?: boolean;
  align?: 'start' | 'center' | 'end';
};
const signaturePin: (props: PinnedProps) => unknown = ProjectIconField;

/**
 * The popover's contents, split at the picker.
 *
 * There are now two `setOpen(false)` call sites inside `<PopoverContent>` — the
 * picker's (which itself has two: `onEmojiSelect` and `onGlyphSelect`) and the
 * remove control's — so a slice that spans both would let either one satisfy
 * an assertion meant for the other. These slices keep each test pointed at
 * exactly the element it names.
 */
const popoverBody = code.slice(code.indexOf('<PopoverContent'), code.indexOf('</PopoverContent>'));
const pickerEnd = popoverBody.indexOf('/>', popoverBody.indexOf('<ProjectIconPicker')) + 2;
/** The `<ProjectIconPicker … />` element alone — both `onEmojiSelect` and
 *  `onGlyphSelect`, and the `defaultTab`/`defaultColor` wiring. */
const pickerElement = popoverBody.slice(popoverBody.indexOf('<ProjectIconPicker'), pickerEnd);
/** Everything after the picker — the remove control. */
const removeBranch = popoverBody.slice(pickerEnd);
/** Just the `onEmojiSelect` handler body, so a test aimed at it cannot pass
 *  against `onGlyphSelect`'s `setOpen(false)` instead. */
const emojiHandler = pickerElement.slice(
  pickerElement.indexOf('onEmojiSelect={'),
  pickerElement.indexOf('onGlyphSelect={'),
);
/** Just the `onGlyphSelect` handler body. */
const glyphHandler = pickerElement.slice(
  pickerElement.indexOf('onGlyphSelect={'),
  pickerElement.indexOf('defaultTab='),
);

describe('ProjectIconField trigger', () => {
  test('renders the selected emoji, and only it', () => {
    const html = render({ value: { emoji: '🚀' } });

    expect(html).toContain('🚀');
    // The fallback glyph is a Phosphor SVG. Both faces on screen at once means
    // the cross-fade has lost its shared box and they are stacked, not swapped.
    expect(html).not.toContain('<svg');
  });

  test('renders the selected glyph, as an svg, and not the emoji face', () => {
    const html = render({ value: { glyph: ROCKET_BLUE } });

    expect(html).toContain('<svg');
    expect(html).not.toContain('🚀');
  });

  test('falls back to a neutral glyph when unset', () => {
    const html = render({ value: null });

    expect(html).toContain('<svg');
  });

  test('an unrenderable glyph name falls back to the neutral glyph too', () => {
    // The server rejects a name outside the catalogue, but a client rendering
    // stale cached data — a project row whose glyph catalogue shrank — must
    // not paint a tinted tile around nothing.
    const html = render({ value: { glyph: { name: 'Skull', color: 'blue' } } });

    expect(html).not.toContain('bg-glyph-fill-blue');
    expect(html).toContain('text-muted-foreground');
  });

  test('names the control for assistive tech in all three states', () => {
    // frimousse/the glyph grid give the trigger no visible text, so the
    // aria-label is the control's only accessible name.
    expect(render({ value: null })).toContain('aria-label="Choose project icon"');
    expect(render({ value: { emoji: '🚀' } })).toContain(
      'aria-label="Project icon: 🚀. Change it"',
    );
    expect(render({ value: { glyph: ROCKET_BLUE } })).toContain(
      'aria-label="Project icon: Rocket. Change it"',
    );
  });

  test('keeps the emoji itself out of the accessibility tree', () => {
    // The button is already named by its aria-label. Without aria-hidden the
    // glyph is announced a second time, after the label that just described it.
    expect(render({ value: { emoji: '🚀' } })).toMatch(/aria-hidden="true"[^>]*>🚀/);
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
    expect(render({ value: null })).toContain('type="button"');
    expect(code).toMatch(/<Button\s[\s\S]*?\btype="button"/);
  });

  test('disabled reaches the button element, not just the styling', () => {
    expect(render({ value: null, disabled: true })).toContain('disabled=""');
    expect(render({ value: null })).not.toContain('disabled=""');
  });

  test('the trigger stays clickable once an icon is picked', () => {
    // THE behaviour of this control: nothing here clears an icon, so the only
    // way to change your mind is to reopen the trigger and pick again. Anything
    // that conditions `disabled` on `value` — `disabled || value !== null` is
    // the obvious slip — makes the field a one-shot and is invisible to a test
    // that only ever renders `value: null`.
    expect(render({ value: { emoji: '🚀' } })).not.toContain('disabled=""');
    expect(render({ value: { emoji: '🚀' }, disabled: true })).toContain('disabled=""');
    expect(render({ value: { glyph: ROCKET_BLUE } })).not.toContain('disabled=""');
    expect(code).toMatch(/disabled=\{disabled\}/);
    expect(code).not.toMatch(/disabled=\{[^}]*\bvalue\b/);
  });

  test('the value prop is the union, and the setters cannot produce it', () => {
    // `signaturePin` is the real guard and only `tsc` can fail it; referencing
    // it here is not the assertion. These are what `bun test` can see.
    expect(signaturePin).toBe(ProjectIconField);
    expect(code).toContain('onChange: (icon: string) => void;');
    expect(code).toContain('onGlyphChange: (glyph: GlyphSelection) => void;');
    expect(code).not.toMatch(/onChange:\s*\(icon: string \| null\)/);
    // The value type itself: a union of the two shapes, not two independently
    // nullable props — grep for the tell-tale shape of "two slots" and fail if
    // it ever creeps back in.
    expect(code).not.toMatch(/emoji\?:\s*string \| null;\s*glyph\?:/);
  });

  test('removing has its own callback, and it is optional', () => {
    // Optional is the load-bearing half: the presence of `onClear` is what
    // gates the remove control below, so a required prop would put a "Remove
    // icon" row in the CREATE modal, where there is nothing saved to undo.
    expect(code).toContain('onClear?: () => void;');
    expect(code).not.toMatch(/onClear:\s*\(\) => void;/);
  });

  test('selecting an emoji reports THAT emoji, and closes the popover', () => {
    // Sliced to the emoji handler alone, not to the whole picker element or to
    // `</PopoverContent>`: both the glyph handler and the remove control carry
    // their own `setOpen(false)`, so a wider slice would keep this green with
    // THIS handler's own close deleted.
    expect(emojiHandler).toMatch(/onChange\(picked\.emoji\)/);
    expect(emojiHandler).not.toMatch(/onChange\(picked\.label\)/);
    expect(emojiHandler).toMatch(/setOpen\(false\)/);
  });

  test('selecting a glyph reports THAT glyph, and closes the popover', () => {
    expect(glyphHandler).toMatch(/onGlyphChange\(picked\)/);
    expect(glyphHandler).toMatch(/setOpen\(false\)/);
  });

  test('reopening a glyph project lands the popover on the Icon tab, pre-coloured', () => {
    // So switching to Emoji-and-back, or just reopening, doesn't lose the tab
    // or colour the user was last looking at.
    expect(pickerElement).toMatch(/defaultTab=\{glyphFace \? 'icon' : 'emoji'\}/);
    expect(pickerElement).toMatch(/defaultColor=\{glyphFace\?\.color\}/);
  });

  test('the popover is controlled in both directions', () => {
    // `open` is a controlled prop, so without onOpenChange nothing can ever set
    // it: the trigger click, outside-click and Escape all route through it. The
    // popover would simply never open.
    expect(code).toMatch(/<Popover\s+open=\{[^}]*\}\s+onOpenChange=\{setOpen\}/);
  });

  test('the popover takes its own scroll lock so the picker can be wheeled', () => {
    // The field renders inside the create-project Modal, a Radix Dialog. Radix
    // wraps the dialog OVERLAY in react-remove-scroll, which installs a
    // non-passive `wheel` listener on `document` and preventDefault()s every
    // wheel that is neither in the overlay's React subtree nor in the content
    // shard. A popover portals to document.body, so it is in neither, and the
    // picker's overflow-y-auto viewport got no scroll at all. Measured in
    // Chromium against the real modal: scrollTop 0 -> 0 for a trusted
    // +400 wheel, defaultPrevented true. The same picker on /design-system,
    // outside any dialog, moved 0 -> 400.
    //
    // `modal` gives this popover its own RemoveScroll, which becomes the last
    // entry in react-remove-scroll's lockStack and therefore the only one that
    // acts. Nothing rendered can show this: with the popover closed there is no
    // markup, and renderToStaticMarkup cannot open it.
    expect(code).toMatch(/<Popover\b[^>]*\bmodal\b/);
  });

  test('`modal` still means "own RemoveScroll lock" in the installed Radix', () => {
    // Guard the guard. The line above is only a fix while Radix implements
    // `modal` by wrapping the content in react-remove-scroll. If that ever
    // becomes focus-trapping alone, the prop stays green and the scroll dies.
    const popover = readFileSync(
      createRequire(import.meta.url).resolve('@radix-ui/react-popover'),
      'utf8',
    );
    const modalBranch = popover.slice(
      popover.indexOf('var PopoverContentModal'),
      popover.indexOf('var PopoverContentNonModal'),
    );

    expect(modalBranch).not.toBe('');
    expect(modalBranch).toContain('RemoveScroll');
  });

  test('the dialog and the popover share ONE react-remove-scroll copy', () => {
    // `lockStack` is module-level state inside react-remove-scroll. The popover
    // can only out-rank the dialog if both locks push onto the SAME array, so
    // the two Radix packages have to resolve to one physical copy. This repo
    // already carries two versions (2.5.4 and 2.7.2) for other packages; if a
    // bump ever put the dialog on one and the popover on the other they would
    // hold independent stacks, both would call preventDefault, and the wheel
    // would die again with every other assertion here still green.
    const sideEffectOf = (pkg: string) =>
      createRequire(createRequire(import.meta.url).resolve(pkg)).resolve(
        'react-remove-scroll/dist/es2015/SideEffect.js',
      );

    expect(sideEffectOf('@radix-ui/react-popover')).toBe(sideEffectOf('@radix-ui/react-dialog'));
  });

  test('react-remove-scroll still lets the newest lock win', () => {
    // The other half of the mechanism. Both locks listen on `document`; the
    // popover's only wins because `shouldPrevent` bails out for any lock that
    // is not last on the stack. Take that away and the dialog's lock cancels
    // the wheel again, with every other test here still green.
    const sideEffect = readFileSync(
      createRequire(createRequire(import.meta.url).resolve('@radix-ui/react-popover')).resolve(
        'react-remove-scroll/dist/es2015/SideEffect.js',
      ),
      'utf8',
    ).replace(/\s+/g, ' ');

    expect(sideEffect).toMatch(/lockStack\[lockStack\.length - 1\] !== Style\) \{ .{0,40}return;/);
  });

  test('disabling the field closes an open popover AND resets the state', () => {
    // Radix drives `open` through useControllableState: a controlled prop that
    // changes value on re-render is recomputed and fires nothing, because
    // onOpenChange only runs from setValue. So the guard alone closes the
    // popover when `disabled` goes true WITHOUT telling us, and local `open`
    // stays true — then `disabled` going false re-evaluates the guard to true
    // and the picker reopens on its own. Task 7 wires `disabled={submitting}`,
    // and a failed create flips that back. The reset is what makes it safe; the
    // guard alone is the bug.
    expect(code).toMatch(/<Popover\s+open=\{open && !disabled\}/);
    expect(code).toMatch(/if \(disabled && open\) setOpen\(false\);/);
  });
});

/**
 * The popover has to be EXACTLY as wide as the emoji grid — and the glyph grid
 * copies the same four literals for the same reason, so the popover never
 * resizes on tab switch.
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
    // The surface comes from the shared FLOATING_PANEL recipe, not a literal
    // in popover.tsx.
    const classes = FLOATING_PANEL.split(/\s+/);

    expect(classes).toContain('border');
    expect(classes.filter((c) => /^border-\d/.test(c))).toEqual([]);
    expect(Number(declared?.[2])).toBe(2);
  });

  test('the popover defaults to hanging off the trigger’s leading edge', () => {
    // Default is `start` — `/new` and the create modal put the trigger on the
    // leading edge of its row, so `center`/`end` would push a ~278px popover
    // past the edge. Hosts that need the other side (Settings' trailing Icon
    // row) pass `align` through; the prop is forwarded, not hardcoded.
    expect(code).toMatch(/align\s*=\s*['"]start['"]/);
    expect(code).toMatch(/<PopoverContent[\s\S]*?align=\{align\}/);
  });

  test('the popover dialog has an accessible name', () => {
    // Radix gives PopoverContent role="dialog". Unlabelled, a screen reader
    // announces "dialog" and nothing else.
    expect(code).toMatch(/<PopoverContent[\s\S]*?aria-label="Choose project icon"/);
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
    // Picking an icon closes the popover, so the eye is on the trigger at the
    // exact moment it changes; a hard swap reads as two objects blinking. The
    // values are the ones the design system fixes for this: scale 0.25 -> 1,
    // opacity 0 -> 1, blur 4px -> 0.
    const swap = code.slice(code.indexOf('const SWAP = {'), code.indexOf('const SWAP_REDUCED'));

    expect(swap).toContain("initial: { scale: 0.25, opacity: 0, filter: 'blur(4px)' }");
    expect(swap).toContain("animate: { scale: 1, opacity: 1, filter: 'blur(0px)' }");
    expect(swap).toContain("exit: { scale: 0.25, opacity: 0, filter: 'blur(4px)' }");

    // All three faces need one shared, fixed box or they cross-fade in
    // different places and the button's width jumps mid-swap.
    // The box is conditional since the unset face became the workspace's own
    // initial tile, which FILLS the trigger; emoji and glyph keep the measured
    // size-6 box. Both arms still live in one `cn()` on one span, which is what
    // 'shared box' means here.
    expect(code).toMatch(/relative inline-flex items-center justify-center/);
    expect(code).toMatch(/'size-full' : 'size-6'/);
    expect(code.match(/absolute inset-0/g)).toHaveLength(1);
  });

  test('the swap spring is buttery, never bouncy', () => {
    expect(code).toContain("transition={{ type: 'spring', duration: 0.3, bounce: 0 }}");
  });

  test('a field that mounts with a value does not animate on first paint', () => {
    expect(code).toContain('<AnimatePresence initial={false}');
  });

  test('re-keys on the picked face so changing icon animates too', () => {
    // Keyed on a constant, AnimatePresence sees one stable child and only the
    // unset <-> set transition animates; picking a different emoji or glyph
    // would otherwise snap. Keyed on colour as well as name for a glyph:
    // recolouring the same glyph is still a visible change to animate.
    expect(code).toMatch(/key=\{identity\}/);
    expect(code).toMatch(
      /const identity = glyphFace \? `glyph:\$\{glyphFace\.name\}:\$\{glyphFace\.color\}` : \(emoji \?\? 'unset'\);/,
    );
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
    //
    // Read from the MARKUP, in all three states. It used to read the source,
    // which stopped meaning anything the moment the className became a cn()
    // call — and each tinted state is its own class list that could lose
    // either one.
    for (const value of [null, { emoji: '🌿' }, { glyph: ROCKET_BLUE }] as const) {
      const classes = (render({ value }).match(/class="([^"]*)"/)?.[1] ?? '').split(/\s+/);

      expect(classes).toContain('hit-area-1');
      expect(classes).toContain('size-9');
    }
  });

  test('the three faces share a box the widest of them actually fits', () => {
    // A text-lg emoji measures 21px. size-5 is 18.39px, so the glyph hung
    // 2.61px out of the box the cross-fade scales and blurs within.
    // The box is conditional since the unset face became the workspace's own
    // initial tile, which fills the trigger; emoji and glyph keep the measured
    // size-6 box.
    expect(code).toMatch(/relative inline-flex items-center justify-center/);
    expect(code).toContain("'size-6'");
  });

  test('the RENDERED button names exact transition properties, never all', () => {
    // This has to read the markup, not the source. Read from source it is
    // trivially true — the component declares no transition of its own — while
    // the button on screen carried Button's base `transition-all`
    // (button.tsx:8) and ran active:scale-[0.96] on it. A test that cannot see
    // the defect it is named after is worse than no test.
    //
    // Button composes through cn(), so tailwind-merge resolves the two into one
    // transition-property utility and the winner is observable here.
    const classes = render({ value: null }).match(/class="([^"]*)"/)?.[1] ?? '';

    expect(classes).toContain('transition-[color,background-color,box-shadow,scale]');
    expect(classes).not.toContain('transition-all');

    // `box-shadow` is in the list because Tailwind draws inset-ring-* with one,
    // and the tinted trigger firms its ring from 1px to 2px on hover. Left out,
    // the ring snaps. Same list the picker's own cells carry.
    //
    // `scale`, not `transform`: Tailwind v4's scale-* utility sets the
    // standalone `scale` property, which `transition-property: transform` does
    // not cover, so listing transform would leave the press snapping.
    expect(classes).not.toMatch(/transition-\[[^\]]*transform/);
  });

  test('the trigger has a real hover state', () => {
    // secondary-outline's hover:bg-secondary is identical to its resting
    // bg-secondary (button.tsx:27), so the trigger gave no hover feedback at
    // all and press scale was the only pointer response. `outline` is what the
    // design system prescribes for an icon-only button and carries a hover fill
    // that differs from its rest — which is what the UNSET trigger still uses.
    const variants = buttonSource.match(/outline:\s*'([^']*)'/)?.[1] ?? '';

    expect(code).toMatch(/variant="outline"/);
    expect(variants).toContain('hover:bg-foreground/5');
    expect(variants).toContain('bg-transparent');

    const unset = render({ value: null }).match(/class="([^"]*)"/)?.[1] ?? '';
    expect(unset).toContain('hover:bg-foreground/5');
  });

  test('the trigger is sized as an icon button', () => {
    // size decides whether the control lines up with the sibling Input at all.
    // The className overrides it to size-9; without size="icon" the base
    // `default` size brings h-9 px-4 and the button stops being square.
    expect(code).toMatch(/size="icon"/);
  });

  test('the cross-fade pops the outgoing face out of layout', () => {
    // mode="popLayout" is what lets the faces overlap during the swap. Without
    // it AnimatePresence keeps the outgoing child in flow and the shared box
    // is no longer shared.
    expect(code).toContain('mode="popLayout"');
  });

  test('the unset glyph reads as a placeholder, not as content', () => {
    // A fallback smiley in the full foreground colour makes an empty field look
    // filled. muted-foreground is the token that says "nothing chosen yet" —
    // and keeping it a token is what the design system requires: nothing else
    // in the toolchain rejects a raw palette class like text-blue-500 here.
    expect(code).toMatch(/<SmileyIcon className="text-muted-foreground size-4" \/>/);
    expect(code).not.toMatch(/\b(?:bg|text|border)-(?:red|blue|green|amber|slate|zinc|gray)-\d/);
    expect(code).not.toMatch(/\b(?:bg|text|border)-\[(?:hsl|rgb|oklch|#)/);
  });
});

/**
 * The trigger's tint when an EMOJI is picked.
 *
 * Once an icon is picked, the trigger stops being a neutral outline button and
 * becomes the picker cell you just hovered — the same pale fill under the same
 * 1px inset ring, at rest. The hue comes from the emoji
 * (components/ui/emoji-tint.ts), which is what makes it match the card and the
 * sidebar row without anything being threaded between them.
 */
describe('ProjectIconField trigger tint — emoji', () => {
  const classesOf = (value: ProjectIconValue) =>
    (render({ value }).match(/class="([^"]*)"/)?.[1] ?? '').split(/\s+/);

  test('a picked emoji tints the trigger at rest', () => {
    const classes = classesOf({ emoji: '🌿' });

    expect(classes).toContain('bg-emoji-fill-green');
    expect(classes).toContain('inset-ring-1');
    expect(classes).toContain('inset-ring-emoji-ring-green');
  });

  test('the tint cancels the outline variant’s own border', () => {
    // `outline` is `border border-border …`. That 1px neutral edge sits OUTSIDE
    // the inset ring, so left standing the trigger reads as a grey box with a
    // coloured line drawn inside it — two edges where the picker cell has one.
    // tailwind-merge resolves the widths into one utility, so the winner shows
    // up in the markup.
    const classes = classesOf({ emoji: '🌿' });

    expect(classes).toContain('border-0');
    expect(classes).not.toContain('border');
  });

  test('an unset trigger stays the plain outline button', () => {
    // There is no emoji or glyph to take a hue from, and a tinted "nothing
    // chosen yet" control would read as filled. The unset face is a muted
    // Smiley on the design system's icon-button chrome, exactly as before.
    const classes = classesOf(null);

    expect(classes.some((c) => c.startsWith('bg-emoji-fill-') || c.startsWith('bg-glyph-fill-'))).toBe(
      false,
    );
    expect(classes.some((c) => c.startsWith('inset-ring-'))).toBe(false);
    expect(classes).toContain('border');
    expect(classes).not.toContain('border-0');
  });

  test('hovering holds the tint instead of washing it out', () => {
    // THE defect this exists to prevent. `outline` carries
    // `hover:bg-foreground/5`, and a :hover rule outranks the resting
    // `bg-emoji-fill-*` on specificity — so without a hold, putting the pointer
    // on a tinted trigger flips it to a neutral wash and back. Restating the
    // fill under the same modifier makes tailwind-merge drop the variant's
    // hover outright, which is observable here.
    const classes = classesOf({ emoji: '🌿' });

    expect(classes).toContain('hover:bg-emoji-fill-green');
    expect(classes).not.toContain('hover:bg-foreground/5');
  });

  test('hover still says something — the ring firms from 1px to 2px', () => {
    // The hold above removes the only pointer feedback the trigger had. The
    // ring is the half of the treatment that carries the contrast, so
    // thickening it is the feedback that stays inside the tint's own language
    // rather than borrowing a neutral fill.
    expect(classesOf({ emoji: '🌿' })).toContain('hover:inset-ring-2');
    expect(classesOf(null)).not.toContain('hover:inset-ring-2');
  });

  test('a different emoji gives a different trigger', () => {
    // Guards every check above against a tint pinned to one hue.
    expect(classesOf({ emoji: '🔥' })).toContain('bg-emoji-fill-amber');
    expect(classesOf({ emoji: '💧' })).toContain('bg-emoji-fill-blue');
    expect(classesOf({ emoji: '🔥' })).not.toContain('bg-emoji-fill-green');
  });

  test('the trigger and the card tile wear the SAME tint for the same emoji', () => {
    // The cross-surface promise, checked across the two components that have to
    // agree — a modal trigger and a grid tile, rendered from different trees
    // with no shared state. Two independent copies of the mapping would drift
    // and nothing else in either file's tests would notice.
    const tintOf = (classes: string[]) =>
      classes.filter((c) => c.includes('emoji-fill-') || c.includes('emoji-ring-')).sort();

    for (const emoji of ['🌿', '🔥', '💧', '🚀', '🤖']) {
      const trigger = tintOf(classesOf({ emoji })).filter((c) => !c.startsWith('hover:'));
      const tile = tintOf(
        (
          renderToStaticMarkup(<EntityAvatar label="Demo" emoji={emoji} size="lg" />).match(
            /class="([^"]*)"/,
          )?.[1] ?? ''
        ).split(/\s+/),
      );

      expect(trigger).toEqual(tile);
      expect(trigger.length).toBe(2);
    }
  });

  test('the trigger takes its emoji tint from the shared module, not a local copy', () => {
    expect(code).toContain("from '@/components/ui/emoji-tint'");
    expect(code).toMatch(/emojiTint\(emoji\)/);
    expect(code).toMatch(/emojiTintHover\(emoji\)/);

    // Spelling the classes out here is the fork that makes the surfaces drift.
    expect(code).not.toMatch(/'[^']*bg-emoji-fill-/);
  });
});

/**
 * The trigger's tint when a GLYPH is picked — same treatment, different
 * source: the hue is CHOSEN (glyph-tint.ts) rather than derived from the
 * glyph itself.
 */
describe('ProjectIconField trigger tint — glyph', () => {
  const classesOf = (value: ProjectIconValue) =>
    (render({ value }).match(/class="([^"]*)"/)?.[1] ?? '').split(/\s+/);

  test('a picked glyph tints the trigger at rest, in its chosen colour', () => {
    const classes = classesOf({ glyph: { name: 'Rocket', color: 'magenta' } });

    expect(classes).toContain('bg-glyph-fill-magenta');
    expect(classes).toContain('inset-ring-1');
    expect(classes).toContain('inset-ring-glyph-ring-magenta');
  });

  test('the glyph tint also cancels the outline variant’s own border', () => {
    const classes = classesOf({ glyph: ROCKET_BLUE });

    expect(classes).toContain('border-0');
    expect(classes).not.toContain('border');
  });

  test('the glyph itself is tinted in its own colour, not left monochrome', () => {
    const html = render({ value: { glyph: ROCKET_BLUE } });

    expect(html).toContain('text-glyph-ring-blue');
  });

  test('hovering holds the glyph tint instead of washing it out', () => {
    const classes = classesOf({ glyph: { name: 'Rocket', color: 'lime' } });

    expect(classes).toContain('hover:bg-glyph-fill-lime');
    expect(classes).not.toContain('hover:bg-foreground/5');
    expect(classes).toContain('hover:inset-ring-2');
  });

  test('a different glyph colour gives a different trigger', () => {
    expect(classesOf({ glyph: { name: 'Rocket', color: 'orange' } })).toContain(
      'bg-glyph-fill-orange',
    );
    expect(classesOf({ glyph: { name: 'Rocket', color: 'purple' } })).toContain(
      'bg-glyph-fill-purple',
    );
    expect(classesOf({ glyph: { name: 'Rocket', color: 'orange' } })).not.toContain(
      'bg-glyph-fill-purple',
    );
  });

  test('the same glyph name in two colours is two different tiles', () => {
    // Guards a tint keyed on the glyph NAME instead of its colour — a
    // plausible slip since the emoji tint (the sibling treatment) IS keyed on
    // the glyph's own identity.
    const blue = classesOf({ glyph: { name: 'Star', color: 'blue' } });
    const red = classesOf({ glyph: { name: 'Star', color: 'red' } });

    expect(blue).toContain('bg-glyph-fill-blue');
    expect(red).toContain('bg-glyph-fill-red');
    expect(blue).not.toContain('bg-glyph-fill-red');
  });

  test('the trigger and the card tile wear the SAME tint for the same glyph', () => {
    const tintOf = (classes: string[]) =>
      classes.filter((c) => c.includes('glyph-fill-') || c.includes('glyph-ring-')).sort();

    for (const glyph of [
      { name: 'Rocket', color: 'blue' },
      { name: 'Star', color: 'magenta' },
      { name: 'Leaf', color: 'lime' },
    ]) {
      const trigger = tintOf(classesOf({ glyph })).filter((c) => !c.startsWith('hover:'));
      const tile = tintOf(
        (
          renderToStaticMarkup(<EntityAvatar label="Demo" glyph={glyph} size="lg" />).match(
            /class="([^"]*)"/,
          )?.[1] ?? ''
        ).split(/\s+/),
      );

      expect(trigger).toEqual(tile);
      expect(trigger.length).toBe(2);
    }
  });

  test('the trigger takes its glyph tint from the shared module, not a local copy', () => {
    expect(code).toContain("from '@/components/ui/glyph-tint'");
    expect(code).toMatch(/glyphTint\(glyphFace\.color\)/);
    expect(code).toMatch(/glyphTintHover\(glyphFace\.color\)/);
    expect(code).toMatch(/glyphForeground\(glyphFace\.color\)/);

    // Spelling the classes out here is the fork that makes the surfaces drift.
    expect(code).not.toMatch(/'[^']*bg-glyph-fill-/);
  });

  test('an emoji and a glyph never tint the trigger at the same time', () => {
    // The union guarantees this at the type level; this is the runtime
    // evidence. A trigger showing both tints would mean the two fields
    // (`value: { emoji }` and `value: { glyph }`) were read independently
    // instead of through the one union prop.
    const emojiOnly = classesOf({ emoji: '🌿' });
    expect(emojiOnly.some((c) => c.startsWith('bg-glyph-fill-'))).toBe(false);

    const glyphOnly = classesOf({ glyph: ROCKET_BLUE });
    expect(glyphOnly.some((c) => c.startsWith('bg-emoji-fill-'))).toBe(false);
  });
});

/**
 * The remove control.
 *
 * Everything here reads source rather than markup, for the same reason the
 * `onEmojiSelect` handler test does: the control lives inside `PopoverContent`,
 * which renders nothing until the popover is open, and `renderToStaticMarkup`
 * cannot open it. `apps/web` has no DOM harness (no jsdom, no
 * testing-library) — see the note at the top of `features/layout/user-menu.test.tsx`.
 * The clicked behaviour is verified by driving the real edit modal in a browser
 * and reading the PATCH it sends.
 */
describe('ProjectIconField remove control', () => {
  test('the popover slices were all found', () => {
    // Guard the guards: every assertion in this file that reads a slice is
    // vacuous against an empty one, and `.toContain` on '' fails in a way that
    // reads like a real defect rather than a stale pattern.
    expect(popoverBody).toContain('<ProjectIconPicker');
    expect(pickerElement).toContain('onEmojiSelect={');
    expect(pickerElement).toContain('onGlyphSelect={');
    expect(pickerElement).not.toContain('Remove icon');
    expect(emojiHandler).not.toBe('');
    expect(glyphHandler).not.toBe('');
    expect(removeBranch).toContain('Remove icon');
  });

  test('it renders only when the host accepts a clear AND there is one to make', () => {
    // Both halves. Without `onClear` the create modal would grow a control its
    // host cannot honour; without `value` an already-empty field would offer a
    // button whose click does nothing.
    expect(removeBranch).toMatch(/\{onClear && value \?/);
  });

  test('clicking it reports the removal and closes the popover', () => {
    // The two lines this control exists for. Calling `onChange` here instead
    // would not even typecheck, but dropping `setOpen(false)` leaves the picker
    // hanging over the modal with nothing left to remove.
    const handler = removeBranch.slice(removeBranch.indexOf('onClick={'));

    expect(handler).toMatch(/onClear\(\)/);
    expect(handler).toMatch(/setOpen\(false\)/);
  });

  test('it is type="button", so it cannot submit a host form', () => {
    // Same trap the trigger carries: the create modal renders this field inside
    // a <form>, and a <button> with no type submits it.
    expect(removeBranch).toMatch(/<Button[\s\S]*?type="button"/);
  });

  test('it names exact transition properties, never all', () => {
    // Button's base class list is `transition-all` (button.tsx:8). Left alone,
    // the press scale below animates on `all`.
    expect(removeBranch).toContain('transition-[color,background-color,scale]');
    expect(removeBranch).not.toContain('transition-all');
    expect(removeBranch).toContain('active:scale-[0.96]');
  });

  test('it is an X, not a trash can', () => {
    // Nothing is deleted here — the icon is a draft value until the modal
    // saves, and Cancel puts it back. Trash is this codebase's glyph for
    // removing a PERSISTED row (gateway-routing fallbacks, the project card's
    // Archive); X is for taking a selection off (members-view invite chips,
    // the composer's attachment previews).
    expect(removeBranch).toMatch(/<XIcon\b/);
    expect(removeBranch).not.toMatch(/<Trash/);
  });

  test('it stays a neutral action, not a destructive-variant button', () => {
    // `variant="destructive"` in this design system is a promise that a
    // ConfirmDialog stands behind it. Nothing is mutated until Save.
    expect(removeBranch).toMatch(/variant="ghost"/);
    expect(removeBranch).not.toMatch(/variant="(?:destructive|danger|error)"/);
  });
});
