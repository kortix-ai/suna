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
const buttonSource = read('../../../components/ui/button.tsx');

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

  test('the trigger stays clickable once an icon is picked', () => {
    // THE behaviour of this control: nothing here clears an icon, so the only
    // way to change your mind is to reopen the trigger and pick again. Anything
    // that conditions `disabled` on `value` — `disabled || value !== null` is
    // the obvious slip — makes the field a one-shot and is invisible to a test
    // that only ever renders `value: null`.
    expect(render({ value: '🚀', onChange: noop })).not.toContain('disabled=""');
    expect(render({ value: '🚀', onChange: noop, disabled: true })).toContain('disabled=""');
    expect(code).toMatch(/disabled=\{disabled\}/);
    expect(code).not.toMatch(/disabled=\{[^}]*\bvalue\b/);
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

  test('selecting an emoji reports THAT emoji, and closes the popover', () => {
    // The two lines the whole component exists for, and the two nothing else
    // here can reach: `renderToStaticMarkup` cannot click, and the handler is a
    // closure inside a portalled child. Swapping `emoji.emoji` for `emoji.label`
    // would ship the string "Rocket" as a project icon with every other gate
    // green; dropping setOpen(false) leaves the picker up over the modal.
    const handler = code.slice(code.indexOf('onEmojiSelect={'), code.indexOf('</PopoverContent>'));

    expect(handler).toMatch(/onChange\(emoji\.emoji\)/);
    expect(handler).not.toMatch(/onChange\(emoji\.label\)/);
    expect(handler).toMatch(/setOpen\(false\)/);
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

  test('the popover hangs off the trigger’s leading edge', () => {
    // align="start" is a layout decision, not a default: the trigger is the
    // leftmost control in the modal row, so `center` or `end` would push a
    // 278px popover out past the modal's edge.
    expect(code).toMatch(/<PopoverContent[\s\S]*?align="start"/);
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

  test('the RENDERED button names exact transition properties, never all', () => {
    // This has to read the markup, not the source. Read from source it is
    // trivially true — the component declares no transition of its own — while
    // the button on screen carried Button's base `transition-all`
    // (button.tsx:8) and ran active:scale-[0.96] on it. A test that cannot see
    // the defect it is named after is worse than no test.
    //
    // Button composes through cn(), so tailwind-merge resolves the two into one
    // transition-property utility and the winner is observable here.
    const classes = render({ value: null, onChange: noop }).match(/class="([^"]*)"/)?.[1] ?? '';

    expect(classes).toContain('transition-[color,background-color,scale]');
    expect(classes).not.toContain('transition-all');

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
    // that differs from its rest.
    const variants = buttonSource.match(/outline:\s*'([^']*)'/)?.[1] ?? '';

    expect(code).toMatch(/variant="outline"/);
    expect(variants).toContain('hover:bg-foreground/5');
    expect(variants).toContain('bg-transparent');
  });

  test('the trigger is sized as an icon button', () => {
    // size decides whether the control lines up with the sibling Input at all.
    // The className overrides it to size-9; without size="icon" the base
    // `default` size brings h-9 px-4 and the button stops being square.
    expect(code).toMatch(/size="icon"/);
  });

  test('the cross-fade pops the outgoing face out of layout', () => {
    // mode="popLayout" is what lets the two absolutely-positioned faces
    // overlap during the swap. Without it AnimatePresence keeps the outgoing
    // child in flow and the shared box is no longer shared.
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
