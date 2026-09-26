# OpenTUI notes (0.5.11)

What wave 0 actually used, with pointers into the installed type definitions.
Paths are relative to `apps/tui/node_modules/`. This is a cheat sheet, not a
reference: `docs/opentui-api-reference.md` is the full extracted surface, and
the `.d.ts` files are the contract.

## Runtime and versions

| Fact | Value |
| --- | --- |
| Packages | `@opentui/core@0.5.11`, `@opentui/react@0.5.11` |
| Runtime | Bun 1.3.14 (`@opentui/core` exports a `bun` condition backed by Bun FFI) |
| React | 19.3.0, through `react-reconciler@0.33` |
| Native lib | `@opentui/core-darwin-arm64` (an optionalDependency per platform, no build step) |
| Install note | `@opentui/core` declares `engines.node: >=26.4.0`; see the comment in the repo `.npmrc` |

## Boot

```tsx
const renderer = await createCliRenderer({ exitOnCtrlC: false });
createRoot(renderer).render(<App />);
```

- `createCliRenderer` — `@opentui/core/renderer.d.ts:196`. Config:
  `@opentui/core/renderer.d.ts:24` (`exitOnCtrlC`, `targetFps`, `screenMode`,
  `useMouse`, `stdin`/`stdout`, `width`/`height`, `useKittyKeyboard`,
  `onDestroy`).
- `exitOnCtrlC: false` forwards Ctrl+C to the app's own handlers. With the
  default `true` the renderer calls `destroy()` on the first Ctrl+C and the
  app never sees the key.
- `createRoot(renderer)` — `@opentui/react/src/reconciler/renderer.d.ts:25`.
  Returns `{ render, unmount }`. There is no `render()` helper export.
- `renderer.destroy()` leaves the alternate screen and restores the cursor.
  Verified: the byte stream ends with `ESC[?1049l ESC[?25h`.

## Intrinsic elements

The full list is `@opentui/react/jsx-namespace.d.ts:40`:
`box`, `text`, `span`, `code`, `diff`, `markdown`, `input`, `textarea`,
`select`, `scrollbox`, `ascii-font`, `tab-select`, `line-number`, `image`,
and the text modifiers `b`, `i`, `u`, `strong`, `em`, `br`, `a`.

Anything else (for example `EmbeddedTerminalRenderable`, the VT panel wave 1
needs) is NOT an intrinsic element. Register it first:

```tsx
import { EmbeddedTerminalRenderable } from '@opentui/core';
import { extend } from '@opentui/react';
extend({ 'embedded-terminal': EmbeddedTerminalRenderable });
```

`extend` — `@opentui/react/src/components/index.d.ts:41`. Module-augment
`OpenTUIComponents` (`@opentui/react/src/types/components.d.ts`) to type it.

### Props

Props are the renderable's options, flat (there is also an equivalent `style`
object). The ones used here:

- Layout, on every element — `@opentui/core/Renderable.d.ts:29`:
  `flexDirection`, `flexGrow`, `flexShrink`, `alignItems`, `justifyContent`,
  `position`, `top`/`right`/`bottom`/`left`, `overflow`, `padding*`,
  `margin*`, `minWidth`/`maxWidth`, plus `width`/`height`/`zIndex`/`visible`
  at `@opentui/core/Renderable.d.ts:64`. Numbers are cells; `'50%'` works.
- `<box>` — `@opentui/core/renderables/Box.d.ts:6`: `border` (bool or a side
  list), `borderStyle`, `borderColor`, `focusedBorderColor`, `title`,
  `titleColor`, `titleAlignment`, `bottomTitle`, `bottomTitleAlignment`,
  `backgroundColor`, `gap`. A title is drawn INTO the top border line, so a
  panel costs no extra row.
- `<text>` — `@opentui/core/renderables/TextBufferRenderable.d.ts:10`: `fg`,
  `bg`, `attributes`, `wrapMode` (`none|char|word`), `truncate`,
  `selectable`. Children must be strings, numbers, or `<span>`/modifier
  elements — never a `<box>`.
- `<span>` — `@opentui/core/renderables/TextNode.d.ts:7`: `fg`, `bg`,
  `attributes`, `link`. Use it to color part of a line.
- `<scrollbox>` — `@opentui/core/renderables/ScrollBox.d.ts:18`:
  `stickyScroll`, `stickyStart: 'bottom'`, `scrollX`/`scrollY`,
  `scrollbarOptions`, plus `rootOptions`/`viewportOptions`/`contentOptions`
  to style the inner boxes. Imperative API on the ref: `scrollTop`
  (`:69`), `scrollBy` (`:80`), `scrollTo` (`:85`). That is the transcript
  container.
- `<input>` — `@opentui/core/renderables/Input.d.ts:6` (a single-line
  `Textarea`): `value`, `placeholder`, `maxLength`, `focused`, `onInput`,
  `onChange`, `onSubmit`.
- `<textarea>` — `@opentui/core/renderables/Textarea.d.ts:14`: `initialValue`,
  `placeholder`, `keyBindings`, `onSubmit`, `onContentChange`,
  `onCursorChange`, `onKeyDown`.
- `<markdown>` / `<code>` / `<diff>` —
  `@opentui/core/renderables/Markdown.d.ts:68`,
  `@opentui/core/renderables/Code.d.ts:23`,
  `@opentui/core/renderables/Diff.d.ts:8`. All three take `content` plus a
  `syntaxStyle`; `code` also takes `filetype`.

**Trap — `onSubmit` on `<input>`/`<textarea>` has an intersection type.** The
React binding declares `(value: string) => void`
(`@opentui/react/src/types/components.d.ts:41`) and the renderable option
declares `(event: SubmitEvent) => void`
(`@opentui/core/renderables/Textarea.d.ts:24`), so the prop type is BOTH and
no single typed parameter satisfies it. Pass a zero-argument handler and read
the value from your own state (see `src/features/session/session-probe.tsx`).

## Hooks

All from `@opentui/react`:

- `useKeyboard(handler, { release? })` —
  `src/hooks/use-keyboard.d.ts:14`. Every mounted component that calls it gets
  every key; there is no capture/bubble. Gate on your own focus state, as
  `src/ui/list.tsx` does with its `focused` prop.
- `useTerminalDimensions()` — `src/hooks/use-terminal-dimensions.d.ts:1`.
  Returns `{ width, height }` and re-renders on SIGWINCH. Deriving every
  region's size from it is the whole resize story: no extra repaint call is
  needed. Verified at 100×30 → 55×20.
- `useRenderer()` — `src/hooks/use-renderer.d.ts:1`. The `CliRenderer`.
- `useOnResize(cb)` — `src/hooks/use-resize.d.ts:1`. Use only for side effects
  that are not layout (for example resizing a PTY).
- `useFocus(cb)` — terminal WINDOW focus, not widget focus.

`KeyEvent` — `@opentui/core/lib/KeyHandler.d.ts:4`: `name`, `ctrl`, `meta`,
`shift`, `option` (Alt), `sequence`, `raw`, `eventType`, `repeated`,
`preventDefault()`.

**Trap — a capital letter arrives two ways.** Raw mode gives `name: 'G'` with
`shift: false`; the kitty protocol gives `name: 'g'` with `shift: true`.
`src/keymap.ts` normalizes an uppercase single letter to lowercase + shift so
one chord matches both, and so `G` does not also match `g`.

**Trap — shift on punctuation is not reliable.** `?` arrives as name `?` with
`shift` set on some terminals and clear on others, so the matcher ignores
shift for single non-alphanumeric keys.

**Trap — Alt is `meta`, not `option`, in a raw terminal.** `Alt+T` outside the
kitty keyboard protocol is the two bytes `ESC t`, which `parseKeypress` reports
as `{ name: 't', meta: true, option: false }`
(`core/chunk-bun-37s3zwb6.js:5447`, the `metaKeyCodeRe` branch). Kitty reports
the same press as `{ option: true, meta: true }` (`:5019`). A matcher that
tests `option` alone leaves every `Alt` chord dead in Terminal.app and iTerm2,
which is exactly what happened through wave 1. `src/keymap.ts`'s `altPressed()`
accepts either flag.

**Trap — `Shift+Enter` is not a distinct key without kitty.** Raw mode sends a
bare `\r` for both, so a legacy terminal cannot tell them apart. `Ctrl+J`
arrives as the linefeed byte (`{ name: 'linefeed', ctrl: false }` — no `ctrl`
chord can match it) and the textarea's own default binding already turns it
into a newline. Bind that, and stand down rather than consuming it.

**Trap — `<markdown>` paints nothing on its first frame.** Its parse and
highlight pass is async, so `flush()` alone captures an empty content area.
Every assertion on rendered markdown has to settle first — 600 ms is what the
transcript's own tests use. Verified: the same content renders blank at 0 ms
and correctly at 600 ms.

**Not a trap — an ordered list keeps its item text.** A live transcript frame
showed `1`, `2`, … `17` on rows of their own and was reported as `<markdown>`
dropping an ordered list's item text. It was not: the turn above it asked the
agent to "Count slowly from 1 to 40, one number per line", and the reply was
the 41 characters `1\n2\n…\n17`, cut short because the turn was aborted. Bare
numbers rendered as bare numbers. `scripts/repro-markdown-list.tsx` is the
standing proof — a 15-item ordered list at the transcript's own nesting
(`scrollbox` → per-turn column `box` → `markdown` with an explicit width),
streaming on and off, at three scroll offsets, asserting that no marker row is
ever text-less. It exits non-zero if one is.

**Trap — `<markdown>` keeps a hard line break where CommonMark folds one.**
`1\n2\n3` is ONE paragraph (`1 2 3`) to a CommonMark renderer; 0.5.11 gives it
three rows. Verified by the same script: 17 bare numbered lines produce 17 rows.
This is the behavior a transcript wants — an agent that writes one item per line
means one row per line — but it means a rendered frame has more rows than a
CommonMark preview of the same text, and a height calculation that assumes
paragraph folding will be wrong.

**Trap — `scrollbarOptions={{ visible: true }}` blanks the viewport.** Forcing
both bars on in 0.5.11 renders the content rows empty and paints only the bar
glyphs. Let the bars auto-show.

**Trap — `pressKey(' ')` is not the space key.** `mockInput.pressKey` wants the
key NAME; space is `pressKey('space')`. A literal `' '` produces no match.

**Trap — Escape needs ~120 ms in a test.** The parser waits to see whether an
`ESC` is a lone Escape or the prefix of a sequence, so an assertion that
captures the next frame immediately after `pressEscape()` reads the frame
before the key landed.

**Trap — `<code>` conceals markdown markers by default.** `conceal` defaults to
TRUE (`@opentui/core/renderables/Code.d.ts`), and for `filetype="markdown"` that
means the syntax is eaten: `# Heading` renders as `Heading`, `**bold**` as
`bold`, `` `code` `` as `code`. A file viewer showing a `.md` file is then
showing a rendering of it, not the file. Pass `conceal={false}` wherever the
point is the SOURCE. Verified at 46x12: the same content renders `Heading` /
`bold and code` with the default and `# Heading` / `**bold** and `code`` with
`conceal={false}`.

**Trap — an explicit `width`/`height` on `<scrollbox>` or `<diff>` paints
outside the viewport.** Sizing one to its parent's OUTER box makes it paint over
the parent's border: measured inside a 46x10 single-bordered box, a
`<scrollbox width={46} height={10}>` printed `row 8` INTO the bottom border
line (`└row 8──────┘`). The renderable takes the size; its clip rectangle does
not follow. Give it no explicit size, let flex measure it (`flexGrow={1}`), and
put `overflow="hidden"` on the container — the same box then draws a clean
`└──────┘` and shows the scrollbar glyph inside its own rectangle. That is why
`transcript.tsx` wraps its scrollbox in an `overflow="hidden"` column and passes
no width.

**Trap — a one-row `<text>` beside a `flexGrow` child collapses without
`flexShrink={0}`.** In a fixed-height column, flexbox shrinks every item to make
the growing one fit, and a `<text>` has no minimum. Measured in a 6-row column
of `<text>HEADER-ROW</text>` + `<box flexGrow={1}>` + `<text>FOOTER-ROW</text>`:
the header row rendered as `bodyE0-ROW` — the body's first line painted through
the collapsed header, leaving the two interleaved. With `flexShrink={0}` on both
texts the same column renders `HEADER-ROW`, four body rows, `FOOTER-ROW`. Every
fixed chrome row next to a growing region needs it.

**Trap — `overflow: hidden` clips absolutely positioned children.** A `<box
overflow="hidden">` — which `src/ui/panel.tsx` is — scissors every descendant
to its own rectangle, including `position="absolute"` ones anchored at the
terminal origin. A `<Modal>`/`<Picker>` mounted inside a panel renders as a
sliver (measured: a 10-column `┌─Switch a` where a 60-column dialog belonged).
Overlays are mounted at the ROOT of the tree; `app.tsx` owns one overlay slot
and features ask for it through a callback.

## Focus

`focused` is a prop on `box`, `input`, `textarea`, `select`, `scrollbox`,
`tab-select` and `line-number` (`@opentui/react/src/types/components.d.ts`).
It is a plain boolean the app owns; OpenTUI does not maintain a focus ring for
you. `app.tsx` keeps one `Focus` value and passes `focused` down.

## Testing

```ts
import { createTestRenderer } from '@opentui/core/testing';   // headless core
import { testRender } from '@opentui/react/test-utils';       // headless + React
```

- `createTestRenderer(options)` — `@opentui/core/testing/test-renderer.d.ts:54`.
  `TestRendererSetup` (`:39`) gives `renderer`, `mockInput`, `mockMouse`,
  `renderOnce()`, `flush()`, `waitFor()`, `waitForFrame()`,
  `waitForVisualIdle()`, `captureCharFrame()`, `captureSpans()`, `resize()`.
- `testRender(node, options)` — `@opentui/react/src/test-utils.d.ts:3`. Same
  setup, with the node already mounted.
- `captureCharFrame()` returns the screen as plain text, one line per row,
  padded with spaces. Assert on it; never on ANSI.
- `mockInput` — `@opentui/core/testing/mock-keys.d.ts:34`: `pressKey`,
  `pressKeys`, `typeText`, `pressEnter`, `pressEscape`, `pressTab`,
  `pressBackspace`, `pressArrow`, `pressCtrlC`, `pasteBracketedText`.

**Trap — wrap key presses in React's `act`.** Without it the state update from
a key has not committed when the next frame is captured, so the assertion
reads the previous frame (and React prints an `act(...)` warning). The
sequence that works:

```ts
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
await act(async () => mockInput.pressKey('j'));
await flush();
expect(captureCharFrame().split('\n')[1]).toStartWith('▌');
```

`testRender`'s own initial mount still logs one `act(...)` warning per test.
It is noise from inside the helper, not a failed assertion.

## Driving the real binary headlessly

The test renderer proves component behavior. To prove the real process boots,
paints, answers keys and restores the terminal, run it under a pseudo-terminal
(macOS `script` cannot: it needs a controlling tty on stdin). `python3 -c` with
`pty.openpty()` + `TIOCSWINSZ` works, and SIGWINCH to the process group
exercises resize. `apps/tui/scripts/live-app.tsx` is the in-process equivalent
for API behavior: it mounts the whole app in the test renderer against a live
API and asserts each route instead of printing frames.
