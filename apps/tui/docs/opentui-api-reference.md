# OpenTUI 0.5.11 API Reference

Source of truth for `apps/tui` (`@opentui/core@0.5.11` + `@opentui/react@0.5.11`,
pinned in `apps/tui/package.json`). Extracted directly from the published
`.d.ts` files (no web access). Every signature below is copied verbatim from
those files; every claim carries a `file:line` citation. Where the `.d.ts`
alone did not answer a question (runtime defaults, exact behavior), the
compiled `.js` in the same npm package was read and is cited explicitly as
**"implementation, not `.d.ts`"** — treat those as verified-but-not-typed
facts, not as part of the type contract.

**Path shorthand used below:**
- `core/…` = `opentui-core-0.5.11/package/…` (the `@opentui/core` npm package contents)
- `react/…` = `opentui-react-0.5.11/package/…` (the `@opentui/react` npm package contents)

Both were extracted to
`/private/tmp/claude-501/.../scratchpad/otui-probe/{opentui-core-0.5.11,opentui-react-0.5.11}/package/`
for this audit; line numbers are `cat -n` line numbers in the respective file
inside that package.

---

## Table of contents

1. [`createCliRenderer` and renderer lifecycle](#1-createclirenderer-and-renderer-lifecycle)
2. [Key events](#2-key-events)
3. [Focus model](#3-focus-model)
4. [JSX intrinsic elements (`@opentui/react`)](#4-jsx-intrinsic-elements-opentuireact)
5. [Styling](#5-styling)
6. [Refs](#6-refs)
7. [Hooks (`@opentui/react`)](#7-hooks-opentuireact)
8. [Testing](#8-testing)
9. [Lifecycle / gotchas](#9-lifecycle--gotchas)

---

## 1. `createCliRenderer` and renderer lifecycle

### 1.1 Function signature

`core/renderer.d.ts:196`:
```ts
export declare function createCliRenderer(config?: CliRendererConfig): Promise<CliRenderer>;
```
Doc comment (`core/renderer.d.ts:191-195`):
```
/**
 * Create a CLI renderer and run its async terminal setup. The constructor
 * owns all stream and backend decisions; this factory only layers on the
 * `--delay-start` flag and the `await setupTerminal()` convenience.
 */
```

Runtime behavior (implementation, not `.d.ts` — `core/chunk-node-54dhb2fr.js:7090-7106`):
```js
async function createCliRenderer2(config = {}) {
  if (process.argv.includes("--delay-start")) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  const stdin = config.stdin ?? process.stdin;
  const stdout = config.stdout ?? process.stdout;
  const width = stdout.columns || config.width || 80;
  const height = stdout.rows || config.height || 24;
  const renderer = new CliRenderer2(stdin, stdout, width, height, config);
  try {
    await renderer.setupTerminal();
    return renderer;
  } catch (error) { renderer.destroy(); throw error; }
}
```
`stdin`/`stdout` default to `process.stdin`/`process.stdout`. `width`/`height`
default to the stream's `columns`/`rows`, then `config.width`/`config.height`,
then `80`/`24`. If `setupTerminal()` throws, `destroy()` runs and the error
re-throws.

### 1.2 `CliRendererConfig` — full options interface

`core/renderer.d.ts:24-59`:
```ts
export interface CliRendererConfig {
    stdin?: NodeJS.ReadStream;
    stdout?: NodeJS.WriteStream;
    width?: number;
    height?: number;
    remote?: boolean;
    kittyImageTransport?: KittyImageTransport;      // "raw" | "zlib" | "file"
    bufferedOutput?: NativeBufferedOutput;
    exitOnCtrlC?: boolean;
    exitSignals?: NodeJS.Signals[];
    clearOnShutdown?: boolean;
    forwardEnvKeys?: string[];
    debounceDelay?: number;
    targetFps?: number;
    maxFps?: number;
    memorySnapshotInterval?: number;
    useThread?: boolean;
    gatherStats?: boolean;
    maxStatSamples?: number;
    consoleOptions?: Omit<ConsoleOptions, "clock">;
    postProcessFns?: ((buffer: OptimizedBuffer, deltaTime: number) => void)[];
    enableMouseMovement?: boolean;
    useMouse?: boolean;
    autoFocus?: boolean;
    screenMode?: ScreenMode;                        // "alternate-screen" | "main-screen" | "split-footer"
    footerHeight?: number;
    externalOutputMode?: ExternalOutputMode;        // "capture-stdout" | "passthrough"
    consoleMode?: ConsoleMode;                      // "console-overlay" | "disabled"
    useKittyKeyboard?: KittyKeyboardOptions | null;
    backgroundColor?: ColorInput;
    openConsoleOnError?: boolean;
    prependInputHandlers?: ((sequence: string) => boolean)[];
    stdinParserMaxBufferBytes?: number;
    clock?: Clock;
    onDestroy?: () => void;
}
```

Runtime defaults (implementation, `core/chunk-node-54dhb2fr.js:7420-7526` and
`:6852-6860` — **not** stated in the `.d.ts`, verified here for completeness):

| Field | Default |
|---|---|
| `exitOnCtrlC` | `true` |
| `exitSignals` | `["SIGINT","SIGTERM","SIGQUIT","SIGABRT","SIGHUP","SIGPIPE","SIGBREAK","SIGBUS"]` |
| `clearOnShutdown` | `true` |
| `forwardEnvKeys` | `DEFAULT_FORWARDED_ENV_KEYS` (`[]` if `remote: true`) |
| `debounceDelay` | `100` |
| `targetFps` | `30` |
| `maxFps` | `60` |
| `memorySnapshotInterval` | `0` (disabled) |
| `gatherStats` | `false` |
| `maxStatSamples` | `300` |
| `enableMouseMovement` | `true` |
| `useMouse` | `true` |
| `autoFocus` | `true` |
| `screenMode` | `"alternate-screen"` (env `OTUI_USE_ALTERNATE_SCREEN` overrides) |
| `footerHeight` | `12`, only used when `screenMode === "split-footer"` |
| `externalOutputMode` | `"passthrough"`, or `"capture-stdout"` if `screenMode === "split-footer"` |
| `consoleMode` | `"console-overlay"` |
| `useKittyKeyboard` | `{}` (enabled, sub-flags at their own defaults) unless explicitly `null` |
| `openConsoleOnError` | `true` |
| `clock` | `new SystemClock()` |
| `postProcessFns` / `prependInputHandlers` | `[]` |

**Constraint**: `externalOutputMode: "capture-stdout"` requires
`screenMode === "split-footer"`; otherwise the renderer throws
`Error('externalOutputMode "capture-stdout" requires screenMode "split-footer"')`
(implementation, `core/chunk-node-54dhb2fr.js:6858-6860,7923-7925`).

`KittyKeyboardOptions` (`core/renderer.d.ts:135-146`, doc comments verbatim):
```ts
export interface KittyKeyboardOptions {
    /** Disambiguate escape codes (fixes ESC timing, alt+key ambiguity, ctrl+c as event). Default: true */
    disambiguate?: boolean;
    /** Report alternate keys (numpad, shifted, base layout) for cross-keyboard shortcuts. Default: true */
    alternateKeys?: boolean;
    /** Report event types (press/repeat/release). Default: false */
    events?: boolean;
    /** Report all keys as escape codes. Default: false */
    allKeysAsEscapes?: boolean;
    /** Report text associated with key events. Default: false */
    reportText?: boolean;
}
```

### 1.3 `CliRenderer` instance API

Class `CliRenderer extends EventEmitter implements RenderContext` —
`core/renderer.d.ts:223`.

Constructor (`core/renderer.d.ts:365-388`, doc comment quoted in full —
authoritative statement of constructor side effects):
```ts
constructor(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream, width: number, height: number, config?: CliRendererConfig);
```
```
/**
 * Construct a renderer over the given streams.
 *
 * If `stdout` is not `process.stdout`, a `NativeSpanFeed` is allocated
 * internally and rendered bytes are piped through it to `stdout` unless
 * `bufferedOutput: "memory"` is set. Prefer `createCliRenderer` for the async
 * `setupTerminal` convenience.
 *
 * Construction side effects (observable before the constructor returns):
 *   - Acquires exclusive ownership of the given stdin/stdout streams
 *   - Allocates a `NativeSpanFeed` (for non-process stdout unless bufferedOutput is "memory")
 *   - Calls `lib.createRenderer` → native Zig allocation
 *   - Registers in the process-wide `rendererTracker`
 *   - Adds `process.on(...)` listeners for SIGWINCH (process.stdout only),
 *     "warning", "uncaughtException", "unhandledRejection", plus the
 *     configured `exitSignals`
 *   - Replaces `global.requestAnimationFrame` with the renderer's impl
 *   - When `setupTerminal()` is called, it will put `stdin` in raw mode and
 *     call `stdin.resume()`
 *
 * Some late constructor side effects are not rolled back if construction
 * throws partway; production callers should use `createCliRenderer`, which
 * wraps `setupTerminal()` in a try/catch that calls `destroy()` on failure.
 */
```

**Key public members** (`core/renderer.d.ts`, line refs inline):
- `width: number; height: number` — `:247-248`
- `get isDestroyed(): boolean` — `:394`
- `get currentFocusedRenderable(): Renderable | null` — `:398`
- `get currentFocusedEditor(): EditBufferRenderable | null` — `:399`
- `focusRenderable(renderable: Renderable): void` / `blurRenderable(renderable: Renderable): void` — `:402-403`
- `get keyInput(): KeyHandler` — `:429` (subscribe with `.on("keypress"|"keyrelease"|"paste", ...)`, see §2)
- `get _internalKeyInput(): InternalKeyHandler` — `:430` (internal, priority-dispatch — see §2.4)
- `get useMouse(): boolean; set useMouse(v: boolean)` — `:438-439`
- `get screenMode(): ScreenMode; set screenMode(mode: ScreenMode)` — `:440-441`
- `get capabilities(): TerminalCapabilities | null` — `:452`
- `resize(width: number, height: number): void` — `:549`, doc comment `:541-548`:
  ```
  /**
   * Programmatically resize the renderer to new dimensions.
   *
   * Use this for externally-driven resize events — for example, an SSH
   * `window-change` signal or a test harness simulating a terminal resize.
   * When the renderer is attached to `process.stdout`, `SIGWINCH` is handled
   * automatically and callers do not need this method.
   */
  ```
- `setBackgroundColor(color: ColorInput): void` — `:550`
- `toggleDebugOverlay(): void` — `:551`
- `configureDebugOverlay(options: { enabled?: boolean; corner?: DebugOverlayCorner }): void` — `:552-555`
- `setCursorPosition(x, y, visible?): void`; `setCursorStyle(options: CursorStyleOptions): void`; `setCursorColor(color: RGBA): void` (instance forms) — `:572-574`, plus identical `static` forms `:569-571`
- `getCursorState(): import("./zig.js").CursorState` — `:575`
- `start(): void; auto(): void; pause(): void; suspend(): void; resume(): void; stop(): void; destroy(): void` — `:584-593`
- `get console(): TerminalConsole` — `:428`
- `get consoleMode(): ConsoleMode; set consoleMode(mode: ConsoleMode)` — `:420-421`
- `getNativeStats(): NativeRenderStats; getStats(): CliRendererStats; resetStats(): void; setGatherStats(enabled: boolean): void` — `:602-605`

`CliRenderer` extends `EventEmitter` — there is no bespoke `.on('resize', …)`
overload; it is the plain inherited `EventEmitter.on(event, listener)`. Event
names are `CliRenderEvents` (`core/renderer.d.ts:197-214`):
```ts
export declare enum CliRenderEvents {
    RESIZE = "resize",
    FRAME = "frame",
    RENDER_ERROR = "render:error",
    HANDLER_ERROR = "handler:error",
    EXTERNAL_OUTPUT = "external_output",
    FOCUS = "focus",
    BLUR = "blur",
    FOCUSED_RENDERABLE = "focused_renderable",
    FOCUSED_EDITOR = "focused_editor",
    THEME_MODE = "theme_mode",
    PALETTE = "palette",
    CAPABILITIES = "capabilities",
    SELECTION = "selection",
    DEBUG_OVERLAY_TOGGLE = "debugOverlay:toggle",
    DESTROY = "destroy",
    MEMORY_SNAPSHOT = "memory:snapshot"
}
```

Usage:
```tsx
import { createCliRenderer, CliRenderEvents } from "@opentui/core";
import { createRoot } from "@opentui/react";

const renderer = await createCliRenderer({ targetFps: 30, exitOnCtrlC: true });
renderer.on(CliRenderEvents.RESIZE, (w: number, h: number) => {
  console.log("resized", w, h);
});
createRoot(renderer).render(<App />);
// on shutdown:
renderer.destroy();
```

### 1.4 Console capture behavior

`core/lib/output.capture.d.ts` (full):
```ts
export type CapturedOutput = { stream: "stdout" | "stderr"; output: string; };
export declare class Capture extends EventEmitter {
    constructor();
    get size(): number;
    write(stream: "stdout" | "stderr", data: string): void;
    claimOutput(): string;
}
export declare class CapturedWritableStream extends Writable {
    isTTY: boolean; columns: number; rows: number;
    constructor(stream: "stdout" | "stderr", capture: Capture);
    getColorDepth(): number;
}
```
`core/console.d.ts:9`: `export declare const capture: Capture;` (process-wide singleton).

**Mechanism** (implementation, `core/chunk-node-54dhb2fr.js:4593-4655` — not in
`.d.ts`): the renderer replaces `global.console` with a `node:console`
`Console` whose `stdout`/`stderr` streams are `CapturedWritableStream`
instances that push writes into the `Capture` buffer instead of the real
terminal, **then additionally monkey-patches** `console.log/info/warn/error/debug`
directly so every call is both cached (ring buffer, `MAX_CACHE_SIZE = 1000`)
and rendered live into the on-screen console overlay. **`console.log` does not
corrupt the terminal UI** — it is intercepted, not written raw to stdout.

**Opt-out**: env var `OTUI_USE_CONSOLE` (default `true`) — doc string in the
bundle: *"Whether to use the console. Will not capture console output if set
to false."* Setting it `false` disables capture entirely; `console.log` then
behaves like plain Node/Bun (writes straight to the real stdout, which will
corrupt the alternate-screen UI).

**Config knobs** on `CliRendererConfig`:
- `consoleMode?: "console-overlay" | "disabled"` (`core/renderer.d.ts:51,68`) — controls whether the overlay UI shows; default `"console-overlay"`.
- `consoleOptions?: Omit<ConsoleOptions, "clock">` (`core/renderer.d.ts:43`) — full shape, `core/console.d.ts:18-41`:
  ```ts
  export interface ConsoleOptions {
      position?: ConsolePosition;       // "top" | "bottom" | "left" | "right"
      sizePercent?: number;
      zIndex?: number;
      colorInfo?/colorWarn?/colorError?/colorDebug?/colorDefault?: ColorInput;
      backgroundColor?: ColorInput;
      startInDebugMode?: boolean;
      title?: string;
      titleBarColor?/titleBarTextColor?/cursorColor?: ColorInput;
      maxStoredLogs?: number;
      maxDisplayLines?: number;
      onCopySelection?: (text: string) => void;
      keyBindings?: ConsoleKeyBinding[];
      keyAliasMap?: KeyAliasMap;
      selectionColor?/copyButtonColor?: ColorInput;
      clock?: Clock;
  }
  ```
- `openConsoleOnError?: boolean` (default `true`) — on `uncaughtException`/`unhandledRejection`/render error, the handler does `console.error(error); if (openConsoleOnError) this.console.show();` (implementation, `core/chunk-node-54dhb2fr.js:7291-7295`) — **it does not call `destroy()`**, so the terminal itself is not restored on crash (see §9).

**Viewing captured logs**: `renderer.console` (`TerminalConsole`, getter
`core/renderer.d.ts:428`) — `.show()`/`.hide()`/`.toggle()`,
`.getCachedLogs(): string` (`core/console.d.ts:113-116`), keyboard-driven
scroll/position/size/save-logs/copy actions (`ConsoleAction` union,
`core/console.d.ts` — `"scroll-up"|"scroll-down"|"scroll-to-top"|"scroll-to-bottom"|"position-previous"|"position-next"|"size-increase"|"size-decrease"|"save-logs"|"copy-selection"`).

Usage:
```tsx
import { useRenderer } from "@opentui/react";

function DebugToggle() {
  const renderer = useRenderer();
  return (
    <box onKeyDown={(k) => k.name === "l" && k.ctrl && renderer.console.toggle()}>
      <text>Ctrl+L toggles the console overlay</text>
    </box>
  );
}
```

---

## 2. Key events

### 2.1 `ParsedKey` / `KeyEvent` shape

`ParsedKey` interface — `core/lib/parse.keypress.d.ts:5-23`:
```ts
export interface ParsedKey {
    name: string;
    ctrl: boolean;
    meta: boolean;
    shift: boolean;
    option: boolean;
    sequence: string;
    number: boolean;
    raw: string;
    eventType: KeyEventType;         // "press" | "repeat" | "release"
    source: "raw" | "kitty";
    code?: string;
    super?: boolean;
    hyper?: boolean;
    capsLock?: boolean;
    numLock?: boolean;
    baseCode?: number;
    repeated?: boolean;
}
```
Parser entry point (`core/lib/parse.keypress.d.ts:24-27`):
```ts
export interface ParseKeypressOptions { useKittyKeyboard?: boolean; }
export declare const parseKeypress: (s?: Buffer | string, options?: ParseKeypressOptions) => ParsedKey | null;
```

**`KeyEvent`** — the class actually delivered to handlers,
`core/lib/KeyHandler.d.ts:4-29`:
```ts
export declare class KeyEvent implements ParsedKey {
    name: string; ctrl: boolean; meta: boolean; shift: boolean; option: boolean;
    sequence: string; number: boolean; raw: string; eventType: KeyEventType;
    source: "raw" | "kitty"; code?: string; super?: boolean; hyper?: boolean;
    capsLock?: boolean; numLock?: boolean; baseCode?: number; repeated?: boolean;
    constructor(key: ParsedKey);
    get defaultPrevented(): boolean;
    get propagationStopped(): boolean;
    preventDefault(): void;
    stopPropagation(): void;
}
```
Identical field set to `ParsedKey` plus `preventDefault()`/`stopPropagation()`.

`PasteEvent` — same file, `:30-41`:
```ts
export declare class PasteEvent {
    type: "paste";
    bytes: Uint8Array;
    metadata?: PasteMetadata;
    constructor(bytes: Uint8Array, metadata?: PasteMetadata);
    get defaultPrevented(): boolean;
    get propagationStopped(): boolean;
    preventDefault(): void;
    stopPropagation(): void;
}
```
Decode with `decodePasteBytes` from `@opentui/core` (`core/lib/paste.d.ts:1-7`)
— `event.bytes: Uint8Array`, **not** `event.text` (the `usePaste` JSDoc example
in `react/src/hooks/use-paste.d.ts` uses `event.text`, which does not exist on
`PasteEvent` — a documentation bug in that package; the React README's own
prose is correct and matches this file).

`KeyHandler` — `core/lib/KeyHandler.d.ts:42-50`:
```ts
export type KeyHandlerEventMap = {
    keypress: [KeyEvent];
    keyrelease: [KeyEvent];
    paste: [PasteEvent];
};
export declare class KeyHandler extends EventEmitter<KeyHandlerEventMap> {
    processParsedKey(parsedKey: ParsedKey): boolean;
    processPaste(bytes: Uint8Array, metadata?: PasteMetadata): void;
}
```
`renderer.keyInput` is a `KeyHandler` — subscribe with
`renderer.keyInput.on("keypress", (event: KeyEvent) => {...})` /
`"keyrelease"` / `"paste"`.

### 2.2 Recognized `name` values

The `.d.ts` only types the key-name lists as `string[]`
(`nonAlphanumericKeys`, `terminalNamedSingleStrokeKeys`,
`core/lib/parse.keypress.d.ts:2-3`; `kittyNamedSingleStrokeKeys`,
`core/lib/parse.keypress-kitty.d.ts:2`) — the literal values live in the
compiled bundle (`core/chunk-node-70eg2nhg.js:5208-5307`, implementation, not
`.d.ts`, but this is the only place the values exist in the package):

| Requested key | `ParsedKey.name` |
|---|---|
| Enter / Return | `"return"` (no separate `"enter"` from raw parsing) |
| Escape | `"escape"` |
| Tab | `"tab"` |
| Backspace | `"backspace"` |
| Delete | `"delete"` |
| Arrow keys | `"up"`, `"down"`, `"left"`, `"right"` |
| Page Up/Down | `"pageup"`, `"pagedown"` |
| Home/End | `"home"`, `"end"` |
| Space | `"space"` |
| F1–F12 | `"f1"` … `"f12"` |

`terminalNamedSingleStrokeKeys` also guarantees `"linefeed"`, plus everything
above.

**Kitty-protocol parsing** — `core/lib/parse.keypress-kitty.d.ts` (full):
```ts
import type { ParsedKey } from "./parse.keypress.js";
export declare const kittyNamedSingleStrokeKeys: string[];
export declare function parseKittyKeyboard(sequence: string): ParsedKey | null;
```
Returns the same `ParsedKey` shape but sets `source: "kitty"` (vs `"raw"`) and
populates fields raw parsing leaves `undefined`: `super`, `hyper`, `capsLock`,
`numLock`, `baseCode`, `repeated`; `eventType` can be `"repeat"`/`"release"`
(raw legacy parsing only ever produces `"press"`). Kitty's key map
(implementation, `core/chunk-node-70eg2nhg.js:4824-4915`) adds many names not
reachable via legacy CSI/SS3 parsing: `capslock`, `scrolllock`, `numlock`,
`printscreen`, `pause`, `f13`–`f35`, `kp0`–`kp9`, `kpenter`,
`kpdecimal`/`kpdivide`/`kpmultiply`/`kpminus`/`kpplus`/`kpequal`, media keys
(`mediaplay`, `mediastop`, …), volume keys, `leftshift`/`rightshift`/…
(distinct left/right modifiers), `iso_level3_shift`, `iso_level5_shift`.

**Alt/Option+key**: `ParsedKey.option: boolean` is the Option/Alt modifier
flag (separate field from `meta`, which usually maps to Cmd/Super on macOS
terminals or the terminal's own "meta" convention — check both when writing
key handlers for Alt-based shortcuts, since terminal emulators disagree on
which of `option`/`meta` they set for Alt).

**Shift+Enter**: nothing in the type system special-cases it, and (see §4.5,
Textarea) the shipped default keybinding table has **no** `{name:"return",
shift:true}` entry — legacy terminals generally cannot even report Shift+Enter
distinctly from Enter without the kitty keyboard protocol
(`TerminalCapabilities.kitty_keyboard`, `core/types.d.ts:62`).

**Ctrl+key**: `ParsedKey.ctrl: boolean`. Note Ctrl+C is additionally special:
if `CliRendererConfig.exitOnCtrlC` is `true` (default), a `keypress` listener
calls `renderer.destroy()` directly on Ctrl+C as a **parsed key event**
(implementation, `core/chunk-node-54dhb2fr.js:7484-7491`), not a signal
handler — so a component's own `keypress` listener for Ctrl+C only fires if
registered ahead of / instead of that behavior (set `exitOnCtrlC: false` to
own Ctrl+C yourself).

### 2.3 `preventDefault` / `stopPropagation` semantics

`KeyEvent`, `PasteEvent`, and `MouseEvent` (`core/renderer.d.ts:154-179`) all
expose the identical pattern:
```ts
get defaultPrevented(): boolean;
get propagationStopped(): boolean;
preventDefault(): void;
stopPropagation(): void;
```

### 2.4 Dispatch order — global first, then the focused renderable

`InternalKeyHandler` — `core/lib/KeyHandler.d.ts:55-61`, doc comment quoted:
```ts
/**
 * This class is used internally by the renderer to ensure global handlers
 * can preventDefault before renderable handlers process events.
 */
export declare class InternalKeyHandler extends KeyHandler {
    onInternal<K extends keyof KeyHandlerEventMap>(event: K, handler: (...args: KeyHandlerEventMap[K]) => void): void;
    offInternal<K extends keyof KeyHandlerEventMap>(event: K, handler: (...args: KeyHandlerEventMap[K]) => void): void;
}
```
Implementation (`core/chunk-node-70eg2nhg.js:1556-1598`, the actual dispatch
algorithm, not visible in the `.d.ts`):
```js
emitWithPriority(event, ...args) {
  for (const listener of this.listeners(event)) {
    listener(...args);
    if (keyEvent.propagationStopped) return;   // renderable phase never runs
  }
  const renderableSet = this.renderableHandlers.get(event);
  if (renderableSet?.size > 0) {
    if (keyEvent.defaultPrevented) return;
    if (keyEvent.propagationStopped) return;
    for (const handler of renderableHandlers) {
      handler(...args);
      if (keyEvent.propagationStopped) return;
    }
  }
}
```
**Confirmed order: (1) global listeners registered via
`renderer.keyInput.on("keypress", ...)`, in registration order, run first.
(2) the currently-focused renderable's internal handler runs second** (wired
up only while a `Renderable` is focused — `Renderable.focus()` calls
`ctx._internalKeyInput.onInternal("keypress", this.keypressHandler)`;
`blur()` calls `offInternal`). Non-focused renderables never receive
`keypress`/`paste` through this path.

- `stopPropagation()` in phase 1 (global) skips phase 2 entirely.
- `preventDefault()` in phase 1 also skips phase 2 (checked once before the
  renderable loop starts).
- Inside the renderable phase, `Renderable`'s installed handler
  (implementation, `core/chunk-node-54dhb2fr.js:527-533`) runs
  `onKeyDown` (the `RenderableOptions.onKeyDown` prop) first, then — only if
  `!key.defaultPrevented` — the renderable's own `handleKeyPress` override.
  So `onKeyDown` can call `preventDefault()` to suppress a component's
  built-in key handling (e.g. suppress Textarea's own Enter/arrow handling).

`useKeyboard` from `@opentui/react` (§7) subscribes at the **global** level
(`renderer.keyInput.on("keypress", ...)`, not the renderable-internal path) —
so a `useKeyboard` handler runs in phase 1, before any focused component's
built-in key handling, and calling `event.preventDefault()`/`stopPropagation()`
inside it can suppress the focused component (e.g. a Textarea) from also
handling that same key.

Usage:
```tsx
import { useKeyboard } from "@opentui/react";

function GlobalEscape({ onClose }: { onClose: () => void }) {
  useKeyboard((key) => {
    if (key.name === "escape") {
      key.preventDefault(); // suppress the focused input's own escape handling, if any
      onClose();
    }
  });
  return null;
}
```

---

## 3. Focus model

Base class `Renderable` — `core/Renderable.d.ts`.

```ts
protected _focusable: boolean;
get focusable(): boolean; set focusable(value: boolean);      // :134,164-165
protected _focused: boolean;
get focused(): boolean;                                        // :135,179 (read-only externally)
focus(): void;                                                  // :176
protected propagateFocusChange(hasFocus: boolean): void;
blur(): void;                                                   // :178
get hasFocusedDescendant(): boolean;                             // :180
```

`RenderableEvents` enum (`core/Renderable.d.ts:15-19`):
```ts
export declare enum RenderableEvents {
    FOCUSED = "focused",
    BLURRED = "blurred",
    DESTROYED = "destroyed"
}
```
`focus()` ends with `this.emit("focused")`; `blur()` ends with
`this.emit("blurred")` (`Renderable extends BaseRenderable extends
EventEmitter`). Separately, `CliRenderer` emits renderer-wide
`CliRenderEvents.FOCUS`/`BLUR`/`FOCUSED_RENDERABLE` (§1.3) when
`renderer.focusRenderable()`/`blurRenderable()` run.

`CliRenderer` tracks a single focused renderable:
`get currentFocusedRenderable(): Renderable | null`
(`core/renderer.d.ts:398`), `focusRenderable(renderable)` /
`blurRenderable(renderable)` (`:402-403`).

**Trap — `renderer.focusRenderable(r)` does NOT give `r` the keyboard.**
The two entry points are not interchangeable, and only one of them routes keys:

| | `Renderable.focus()` | `renderer.focusRenderable(r)` |
| --- | --- | --- |
| sets `r._focused` | yes | no |
| records `currentFocusedRenderable` | yes (it calls `focusRenderable` itself) | yes |
| emits `focused_renderable` | yes | yes |
| **installs the keypress handler** | **yes** | **no** |
| blurs the previous renderable | yes | yes |

`Renderable.focus()` (implementation, `core/chunk-bun-bwjmgnxw.js:523-552`)
sets `_focused`, calls `this._ctx.focusRenderable(this)`, **then** registers the
handler that is the entire key path:

```js
this.ctx._internalKeyInput.onInternal("keypress", this.keypressHandler);
this.ctx._internalKeyInput.onInternal("paste", this.pasteHandler);
```

`blur()` (`:565-580`) is the mirror image and calls `offInternal`.
`focusRenderable` on its own (`:7630-7647`) only swaps the pointer and emits
the events — no `onInternal`, so the renderable's `onKeyDown` and
`handleKeyPress` are never called.

Measured in wave 1D: the embedded terminal focused with `focusRenderable`
painted a live shell prompt and swallowed every keystroke. **Always call
`renderable.focus()` on the element's own ref.** Attach it with a ref
*callback*, not a plain ref read in an effect: the element can mount after the
effect that would focus it, and the panel then opens focused with a dead
keyboard.

### `focusable`/`focused` on JSX elements

At the React layer, `focused?: boolean` is a **controlled, one-way prop** on
7 intrinsic elements: `box`, `input`, `textarea`, `select`, `scrollbox`,
`tab-select`, `line-number` (`react/src/types/components.d.ts:40,42,48,59,
64,68,73`). There is **no `onFocus`/`onBlur` change-notification prop** on
any of these — the consumer holds its own "which field is active" state and
passes `focused={state === "x"}` down. See the Login Form pattern in §7.5.

**Important**: `@opentui/react`'s `useFocus`/`useBlur` hooks are **not**
element-focus hooks — they subscribe to the terminal window gaining/losing OS
focus, not a component becoming focused. See §7.6.

### How focusable components consume keys when focused

`ScrollBox.handleKeyPress(key: KeyEvent): boolean` (`core/renderables/
ScrollBox.d.ts`), `TextareaRenderable.handleKeyPress`/`InputRenderable`
(inherits it), `SelectRenderable.handleKeyPress`, `TabSelectRenderable.
handleKeyPress`, `EmbeddedTerminalRenderable.handleKeyPress` — each renderable
that consumes keys implements this method, which the `InternalKeyHandler`
dispatch (§2.4) invokes only while that renderable is focused. `<select>`
consumes arrow-key navigation and Enter-to-select this way; `<scrollbox>`
consumes arrow/page keys for scroll position; `<textarea>`/`<input>` consume
character input plus the full default keybinding table (§4.5).

---

## 4. JSX intrinsic elements (`@opentui/react`)

### 4.0 How props are typed

Every intrinsic element's prop type is built from one generic
(`react/src/types/components.d.ts:22-25`):
```ts
type ComponentProps<TOptions extends RenderableOptions<TRenderable>, TRenderable extends BaseRenderable> =
  TOptions & { style?: Partial<Omit<TOptions, GetNonStyledProperties<RenderableConstructor<TRenderable>>>> } & ReactProps<TRenderable>;
```
i.e. **every direct prop is also settable through `style={{...}}`**, except a
few excluded per-component keys (content-ish props like `content`/`value`,
and every `on*` handler — `NonStyledProps` excludes `` `on${string}` `` via a
template-literal type, `components.d.ts:4`). `ReactProps<TRenderable>`
(`components.d.ts:6-9`) is `{ key?: React.Key; ref?: React.Ref<TRenderable> }`.

The full `JSX.IntrinsicElements` map — `react/jsx-namespace.d.ts:40-63`:
```ts
interface IntrinsicElements extends React.JSX.IntrinsicElements, ExtendedIntrinsicElements<OpenTUIComponents> {
    box: BoxProps
    text: TextProps
    span: SpanProps
    code: CodeProps
    diff: DiffProps
    markdown: MarkdownProps
    input: InputProps
    textarea: TextareaProps
    select: SelectProps
    scrollbox: ScrollBoxProps
    "ascii-font": AsciiFontProps
    "tab-select": TabSelectProps
    "line-number": LineNumberProps
    image: ImageProps
    b: SpanProps; i: SpanProps; u: SpanProps; strong: SpanProps; em: SpanProps
    br: LineBreakProps
    a: LinkProps
}
```
Matching runtime registry — `react/src/components/index.d.ts:4-26`
(`baseComponents`, tag string → core renderable class).

**`text-table`, `embedded-terminal`, `slider`, `scrollbar` are NOT built-in
JSX tags in v0.5.11**, even though their core classes ship in
`@opentui/core` (`TextTableRenderable`, `EmbeddedTerminalRenderable`,
`SliderRenderable`, `ScrollBarRenderable`). To use them from React, register
them via `extend()` — see §4.11–4.14.

### 4.1 `<box>`

`BoxProps` — `react/src/types/components.d.ts:38-40`:
```ts
export type BoxProps = ComponentProps<ContainerProps<BoxOptions>, BoxRenderable> & {
    focused?: boolean;
};
```
`BoxOptions` — `core/renderables/Box.d.ts:6-23`:
```ts
export interface BoxOptions<TRenderable extends Renderable = BoxRenderable> extends RenderableOptions<TRenderable> {
    backgroundColor?: string | RGBA;
    borderStyle?: BorderStyle;                // "single" | "double" | "rounded" | "heavy"
    border?: boolean | BorderSides[];         // BorderSides = "top"|"right"|"bottom"|"left"
    borderColor?: string | RGBA;
    customBorderChars?: BorderCharacters;
    shouldFill?: boolean;
    title?: string;
    titleColor?: string | RGBA;
    titleAlignment?: "left" | "center" | "right";
    bottomTitle?: string;
    bottomTitleAlignment?: "left" | "center" | "right";
    focusedBorderColor?: ColorInput;
    focusable?: boolean;
    gap?: number | `${number}%`;
    rowGap?: number | `${number}%`;
    columnGap?: number | `${number}%`;
}
```
Defaults (`Box.d.ts:39-48`): `borderStyle: "single"`, `border: false`,
`shouldFill: true`, `titleAlignment: "left"`, `bottomTitleAlignment: "left"`.
`style` excludes `title`/`bottomTitle` in addition to the generic
`NonStyledProps` (`components.d.ts:17`). `children?: React.ReactNode` comes
from `ContainerProps` (`components.d.ts:19-21`). Ref:
`React.Ref<BoxRenderable>`.

```tsx
<box
  title="Session"
  border
  borderStyle="rounded"
  borderColor="#555"
  padding={1}
  flexDirection="column"
  gap={1}
>
  <text>Hello</text>
</box>
```

### 4.2 `<text>`, `<span>`, `<b>`/`<strong>`, `<i>`/`<em>`, `<u>`, `<br>`, `<a>`

`TextProps` — `components.d.ts:28-30`:
```ts
export type TextProps = ComponentProps<TextOptions, TextRenderable> & { children?: TextChildren };
```
`TextOptions` — `core/renderables/Text.d.ts:8-10`:
```ts
export interface TextOptions extends TextBufferOptions { content?: StyledText | string; }
```
`TextBufferOptions` (base) — `core/renderables/TextBufferRenderable.d.ts:10-21`:
```ts
export interface TextBufferOptions extends RenderableOptions<TextBufferRenderable> {
    fg?: string | RGBA;
    bg?: string | RGBA;
    selectionBg?: string | RGBA;
    selectionFg?: string | RGBA;
    selectable?: boolean;
    attributes?: number;
    wrapMode?: "none" | "char" | "word";
    tabIndicator?: string | number;
    tabIndicatorColor?: string | RGBA;
    truncate?: boolean;
}
```
Defaults (`TextBufferRenderable.d.ts:41-52`): `selectable: true`,
`wrapMode: "none"`, `truncate: false`. `style` excludes `content`
(`components.d.ts:17`). Ref: `React.Ref<TextRenderable>`.

`SpanProps` — `components.d.ts:31-33`:
```ts
export type SpanProps = ComponentProps<TextNodeOptions, TextNodeRenderable> & { children?: TextChildren };
```
`TextNodeOptions` — `core/renderables/TextNode.d.ts:7-14`:
```ts
export interface TextNodeOptions extends BaseRenderableOptions {
    fg?: string | RGBA;
    bg?: string | RGBA;
    attributes?: number;
    link?: { url: string };
}
```
`b`/`strong`/`i`/`em`/`u` all type as `SpanProps` (`react/jsx-namespace.d.ts:56-60`)
but map to distinct core classes at runtime
(`react/src/components/text.d.ts:4-19`): `b`/`strong` → `BoldSpanRenderable`;
`i`/`em` → `ItalicSpanRenderable`; `u` → `UnderlineSpanRenderable`. **Must be
used inside `<text>`** (per the React README).

`LineBreakProps` — `components.d.ts:37`:
```ts
export type LineBreakProps = Pick<SpanProps, "id">;
```
**`<br>` accepts only `id`** — no `ref`, `style`, `children`, or `key` (a
`Pick`, not an intersection with `ReactProps`).

`LinkProps` — `components.d.ts:34-36`:
```ts
export type LinkProps = SpanProps & { href: string; };
```

```tsx
<text fg="#e0e0e0">
  Plain, <b>bold</b>, <i>italic</i>, <u>underlined</u>.
  <br />
  <a href="https://kortix.com">link</a>
</text>
```

### 4.3 `<scrollbox>`

`ScrollBoxProps` — `components.d.ts:63-65`:
```ts
export type ScrollBoxProps = ComponentProps<ContainerProps<ScrollBoxOptions>, ScrollBoxRenderable> & { focused?: boolean; };
```
`ScrollBoxOptions extends BoxOptions<ScrollBoxRenderable>` —
`core/renderables/ScrollBox.d.ts:18-32`:
```ts
export interface ScrollBoxOptions extends BoxOptions<ScrollBoxRenderable> {
    rootOptions?: BoxOptions;
    wrapperOptions?: BoxOptions;
    viewportOptions?: BoxOptions;
    contentOptions?: BoxOptions;
    scrollbarOptions?: Omit<ScrollBarOptions, "orientation">;
    verticalScrollbarOptions?: Omit<ScrollBarOptions, "orientation">;
    horizontalScrollbarOptions?: Omit<ScrollBarOptions, "orientation">;
    stickyScroll?: boolean;
    stickyStart?: "bottom" | "top" | "left" | "right";
    scrollX?: boolean;
    scrollY?: boolean;
    scrollAcceleration?: ScrollAcceleration;   // { tick(now?): number; reset(): void }
    viewportCulling?: boolean;
}
```
(extends `BoxOptions` — all Box props, including `border`/`padding`, apply.)

`ScrollBoxRenderable` methods (`core/renderables/ScrollBox.d.ts:65-126`):
```ts
get/set stickyScroll(): boolean;
get/set stickyStart(): "bottom"|"top"|"left"|"right"|undefined;
get/set scrollTop(): number;
get/set scrollLeft(): number;
get scrollWidth(): number;
get scrollHeight(): number;
scrollBy(delta: number | { x: number; y: number }, unit?: ScrollUnit): void;   // ScrollUnit = "absolute"|"viewport"|"content"|"step"
scrollTo(position: number | { x: number; y: number }): void;
scrollChildIntoView(childId: string): void;
get/set viewportCulling(): boolean;
```
Ref: `React.Ref<ScrollBoxRenderable>`.

```tsx
import { useRef } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";

function Transcript({ children }: { children: React.ReactNode }) {
  const ref = useRef<ScrollBoxRenderable>(null);
  return (
    <scrollbox
      ref={ref}
      stickyScroll
      stickyStart="bottom"
      style={{ flexGrow: 1 }}
      scrollbarOptions={{ showArrows: false }}
    >
      {children}
    </scrollbox>
  );
}
```

### 4.4 `<input>`

`InputProps` — `components.d.ts:41-46`:
```ts
export type InputProps = ComponentProps<InputRenderableOptions, InputRenderable> & {
    focused?: boolean;
    onInput?: (value: string) => void;
    onChange?: (value: string) => void;
    onSubmit?: (value: string) => void;
};
```
`InputRenderableOptions` — `core/renderables/Input.d.ts:6-15`:
```ts
export interface InputRenderableOptions extends Omit<TextareaOptions, "height" | "minHeight" | "maxHeight" | "initialValue"> {
    /** Initial text value (newlines are stripped) */
    value?: string;
    /** Minimum number of characters allowed */
    minLength?: number;
    /** Maximum number of characters allowed */
    maxLength?: number;
    /** Placeholder text (Input only supports string, not StyledText) */
    placeholder?: string;
}
```
`style` excludes `placeholder`/`value` (`components.d.ts:17`). Ref:
`React.Ref<InputRenderable>`.

Core class doc comment (`core/renderables/Input.d.ts:21-31`, verbatim):
```
/**
 * InputRenderable - A single-line text input component.
 *
 * Extends TextareaRenderable with single-line constraints:
 * - Height is always 1
 * - No text wrapping
 * - Newlines are stripped from input
 * - Enter key submits instead of inserting newline
 *
 * Inherits all keybindings from TextareaRenderable.
 */
```
Core events (`InputRenderableEvents`, `Input.d.ts:16-20`): `INPUT = "input"`,
`CHANGE = "change"`, `ENTER = "enter"` — the React-layer `onInput`/`onChange`/
`onSubmit` **props are a narrowed wrapper**, not a 1:1 passthrough of these
event names; they deliver just the string `value`. Cursor API is inherited
from `EditBufferRenderable` (§ below) — `cursorOffset`, `logicalCursor`,
`visualCursor`, `setCursor(row, col)`.

```tsx
<box title="Username" style={{ border: true, height: 3 }}>
  <input
    placeholder="Enter username..."
    maxLength={64}
    onInput={setUsername}
    onSubmit={handleSubmit}
    focused={focusField === "username"}
  />
</box>
```

### 4.5 `<textarea>`

`TextareaProps` — `components.d.ts:47-53`:
```ts
export type TextareaProps = ComponentProps<TextareaOptions, TextareaRenderable> & {
    focused?: boolean;
    onSubmit?: () => void;
    onContentChange?: (event: ContentChangeEvent) => void;
    onCursorChange?: (event: CursorChangeEvent) => void;
    onKeyDown?: (event: KeyEvent) => void;
};
```
`TextareaOptions` — `core/renderables/Textarea.d.ts:14-25`:
```ts
export interface TextareaOptions extends EditBufferOptions {
    initialValue?: string;
    backgroundColor?: ColorInput;
    textColor?: ColorInput;
    focusedBackgroundColor?: ColorInput;
    focusedTextColor?: ColorInput;
    placeholder?: StyledText | string | null;
    placeholderColor?: ColorInput;
    keyBindings?: KeyBinding[];
    keyAliasMap?: TextareaKeyAliasMap;
    onSubmit?: (event: SubmitEvent) => void;   // SubmitEvent is an empty interface
}
```
`EditBufferOptions` (base) — `core/renderables/EditBufferRenderable.d.ts:26-45`:
```ts
export interface EditBufferOptions extends RenderableOptions<EditBufferRenderable> {
    textColor?: string | RGBA;
    backgroundColor?: string | RGBA;
    selectionBg?: string | RGBA;
    selectionFg?: string | RGBA;
    selectable?: boolean;
    attributes?: number;
    wrapMode?: "none" | "char" | "word";
    scrollMargin?: number;
    scrollSpeed?: number;
    showCursor?: boolean;
    cursorColor?: string | RGBA;
    cursorStyle?: CursorStyleOptions;          // { style?: "block"|"line"|"underline"|"default"; blinking?: boolean; color?: RGBA; cursor?: MousePointerStyle }
    selectionOccupancy?: SelectionOccupancy;   // "cell" | "boundary"
    syntaxStyle?: SyntaxStyle;
    tabIndicator?: string | number;
    tabIndicatorColor?: string | RGBA;
    onCursorChange?: (event: CursorChangeEvent) => void;
    onContentChange?: (event: ContentChangeEvent) => void;
}
```
Defaults (`EditBufferRenderable.d.ts:73-91`): `showCursor: true`,
`cursorStyle: { style: "block"; blinking: true }`. `style` excludes
`placeholder`/`initialValue`. Ref: `React.Ref<TextareaRenderable>`.

`CursorChangeEvent`/`ContentChangeEvent` — `EditBufferRenderable.d.ts:20-25`:
```ts
export interface CursorChangeEvent { line: number; visualColumn: number; }
export interface ContentChangeEvent {}
```

**Multiline / wrapping**: multiline by default; `wrapMode?: "none" | "char" |
"word"` (inherited). Height is plain generic layout (`height`/`minHeight`/
`maxHeight` from `LayoutOptions`) — there is no textarea-specific min/max
height field; `InputRenderableOptions` explicitly `Omit`s those three to pin
Input to one line.

**Cursor position API** (inherited from `EditBufferRenderable`,
`EditBufferRenderable.d.ts:96-103,152,172-174`):
```ts
get logicalCursor(): LogicalCursor;    // { row, col } shape (from zig.js)
get visualCursor(): VisualCursor;
get cursorOffset(): number; set cursorOffset(offset: number);
get cursorCharacterOffset(): number | undefined;
setCursor(row: number, col: number): void;
gotoLine(line: number): void; gotoLineStart(): void; gotoLineTextEnd(): void;
```
Also: `get plainText(): string`, `getSelectedText()`, `setText(text)` (full
reset, clears undo history) vs `replaceText(text)` (preserves undo history —
doc comments verbatim, `EditBufferRenderable.d.ts:226-235`):
```
/**
 * Set text and completely reset the buffer state (clears history, resets add_buffer).
 * Use this for initial text setting or when you want a clean slate.
 */
setText(text: string): void;
/**
 * Replace text while preserving undo history (creates an undo point).
 * Use this when you want the setText operation to be undoable.
 */
replaceText(text: string): void;
```

**Enter vs Shift+Enter — verified in the bundled runtime (not visible from
the `.d.ts` alone; `defaultTextareaKeyBindings: KeyBinding[]` is declared with
no literal value at `Textarea.d.ts:11`).** Read from
`core/index.node.js:8745-8808` (implementation):
```js
{ name: "return", action: "newline" },
{ name: "kpenter", action: "newline" },
{ name: "linefeed", action: "newline" },
{ name: "return", meta: true, action: "submit" },
{ name: "kpenter", meta: true, action: "submit" },
```
**There is no `shift: true` binding on Enter anywhere in the default table.**
Plain Enter inserts a newline; **meta**+Enter (Option/Cmd+Enter depending on
terminal — check `KeyEvent.meta` vs `.option`) submits. Shift+Enter matches no
binding, and the raw-insert fallback in `handleKeyPress` rejects control
characters (`firstCharCode < 32`), so **out of the box Shift+Enter does
nothing**. To make Shift+Enter submit (or insert) explicitly, override via
`TextareaOptions.keyBindings` (a `BaseKeyBinding<TextareaAction>[]`) or
intercept in `onKeyDown`/the React `onKeyDown` prop and call
`event.preventDefault()` before the built-in handler runs (see §2.4 dispatch
order).

`TextareaAction` full union (`Textarea.d.ts:3-9`):
```ts
export type TextareaAction =
  | "move-left" | "move-right" | "move-up" | "move-down"
  | "select-left" | "select-right" | "select-up" | "select-down"
  | "line-home" | "line-end" | "select-line-home" | "select-line-end"
  | "visual-line-home" | "visual-line-end" | "select-visual-line-home" | "select-visual-line-end"
  | "buffer-home" | "buffer-end" | "select-buffer-home" | "select-buffer-end"
  | "delete-line" | "delete-to-line-end" | "delete-to-line-start"
  | "backspace" | "delete" | "newline" | "undo" | "redo"
  | "word-forward" | "word-backward" | "select-word-forward" | "select-word-backward"
  | "delete-word-forward" | "delete-word-backward" | "select-all" | "submit";
```

```tsx
import { useRef } from "react";
import type { TextareaRenderable, KeyBinding } from "@opentui/core";

const submitOnShiftEnter: KeyBinding[] = [
  { name: "return", shift: true, action: "submit" },
  { name: "return", action: "newline" }, // keep plain Enter as newline
];

function Composer({ onSubmit }: { onSubmit: (text: string) => void }) {
  const ref = useRef<TextareaRenderable>(null);
  return (
    <textarea
      ref={ref}
      placeholder="Type a message..."
      keyBindings={submitOnShiftEnter}
      onSubmit={() => onSubmit(ref.current?.plainText ?? "")}
      focused
    />
  );
}
```

### 4.6 `<select>`

`SelectProps` — `components.d.ts:58-62`:
```ts
export type SelectProps = ComponentProps<SelectRenderableOptions, SelectRenderable> & {
    focused?: boolean;
    onChange?: (index: number, option: SelectOption | null) => void;
    onSelect?: (index: number, option: SelectOption | null) => void;
};
```
`SelectRenderableOptions` — `core/renderables/Select.d.ts:16-36`:
```ts
export interface SelectRenderableOptions extends RenderableOptions<SelectRenderable> {
    backgroundColor?: ColorInput; textColor?: ColorInput;
    focusedBackgroundColor?: ColorInput; focusedTextColor?: ColorInput;
    options?: SelectOption[];
    selectedIndex?: number;
    selectedBackgroundColor?: ColorInput; selectedTextColor?: ColorInput;
    descriptionColor?: ColorInput; selectedDescriptionColor?: ColorInput;
    showScrollIndicator?: boolean;
    wrapSelection?: boolean;
    showDescription?: boolean;
    showSelectionIndicator?: boolean;
    font?: keyof typeof fonts;             // ASCIIFontName
    itemSpacing?: number;
    fastScrollStep?: number;
    keyBindings?: SelectKeyBinding[];
    keyAliasMap?: KeyAliasMap;
}
```
`SelectOption` — `Select.d.ts:9-13`:
```ts
export interface SelectOption { name: string; description: string; value?: any; }
```
Defaults (`Select.d.ts:67-83`): `showScrollIndicator: false`,
`wrapSelection: false`, `showDescription: true`, `showSelectionIndicator: true`.
Core events (`SelectRenderableEvents`, `Select.d.ts`):
`SELECTION_CHANGED = "selectionChanged"`, `ITEM_SELECTED = "itemSelected"` —
the React `onChange`/`onSelect` props wrap these. Ref:
`React.Ref<SelectRenderable>`.

```tsx
<select
  options={[
    { name: "gpt-5", description: "Fast, general purpose" },
    { name: "opus", description: "Best for hard reasoning" },
  ]}
  selectedIndex={0}
  wrapSelection
  onChange={(index, option) => setModel(option?.name)}
  focused
/>
```

### 4.7 `<tab-select>`

`TabSelectProps` — `components.d.ts:67-71`:
```ts
export type TabSelectProps = ComponentProps<TabSelectRenderableOptions, TabSelectRenderable> & {
    focused?: boolean;
    onChange?: (index: number, option: TabSelectOption | null) => void;
    onSelect?: (index: number, option: TabSelectOption | null) => void;
};
```
`TabSelectRenderableOptions` — `core/renderables/TabSelect.d.ts:15-32`:
```ts
export interface TabSelectRenderableOptions extends Omit<RenderableOptions<TabSelectRenderable>, "height"> {
    height?: number;
    options?: TabSelectOption[];
    tabWidth?: number;
    backgroundColor?: ColorInput; textColor?: ColorInput;
    focusedBackgroundColor?: ColorInput; focusedTextColor?: ColorInput;
    selectedBackgroundColor?: ColorInput; selectedTextColor?: ColorInput; selectedDescriptionColor?: ColorInput;
    showScrollArrows?: boolean;
    showDescription?: boolean;
    showUnderline?: boolean;
    wrapSelection?: boolean;
    keyBindings?: TabSelectKeyBinding[];
    keyAliasMap?: KeyAliasMap;
}
```
`TabSelectOption` — same shape as `SelectOption`. **No `selectedIndex` option
field** (only `setSelectedIndex()`/`getSelectedIndex()` methods, reachable via
ref). Core events: `TabSelectRenderableEvents.SELECTION_CHANGED` /
`ITEM_SELECTED`. Ref: `React.Ref<TabSelectRenderable>`.

```tsx
<tab-select
  options={[
    { name: "Transcript", description: "" },
    { name: "Files", description: "" },
  ]}
  onChange={(i) => setTab(i)}
/>
```

### 4.8 `<markdown>`

`MarkdownProps` — `components.d.ts:56`:
```ts
export type MarkdownProps = ComponentProps<MarkdownOptions, MarkdownRenderable>;
```
`MarkdownOptions` — `core/renderables/Markdown.d.ts:68-107`:
```ts
export interface MarkdownOptions extends RenderableOptions<MarkdownRenderable> {
    content?: string;
    syntaxStyle: SyntaxStyle;        // REQUIRED, not optional
    fg?: ColorInput; bg?: ColorInput;
    /** Controls concealment for markdown syntax markers in markdown text blocks. */
    conceal?: boolean;
    /** Controls concealment inside fenced code blocks rendered by CodeRenderable. */
    concealCode?: boolean;
    treeSitterClient?: TreeSitterClient;
    /**
     * Enable streaming mode for incremental content updates.
     *
     * Semantics:
     * - The trailing markdown block stays unstable while streaming is enabled.
     * - Tables render all rows produced by the markdown parser (including trailing rows).
     * - Incomplete table rows are normalized by the parser and rendered with empty cells
     *   where data is missing.
     *
     * Expectations:
     * - Keep this true while chunks are still being appended.
     * - Set this to false once streaming is complete to finalize trailing token parsing.
     */
    streaming?: boolean;
    tableOptions?: MarkdownTableOptions;
    renderNode?: (token: Token, context: RenderNodeContext) => Renderable | undefined | null;
    internalBlockMode?: "coalesced" | "top-level";   // internal only
}
```
`style` excludes `content`/`syntaxStyle`/`treeSitterClient`/`conceal`/
`renderNode` (`components.d.ts:17`) — `tableOptions`/`streaming`/
`concealCode`/`internalBlockMode` ARE style-able. No `children` prop — content
is driven entirely by `content: string`. Ref: `React.Ref<MarkdownRenderable>`.

**Streaming**: `MarkdownRenderable.content` is a plain get/set string;
**there is no `append()` method** — streaming means "keep reassigning
`content` to the accumulated full string while `streaming: true`", backed by
an incremental re-parser exported separately
(`core/renderables/markdown-parser.d.ts:11`, doc comment verbatim):
```ts
/**
 * Incrementally parse markdown, reusing unchanged tokens from previous parse.
 * Compares token.raw at each offset - matching tokens keep same object reference.
 */
export declare function parseMarkdownIncremental(newContent: string, prevState: ParseState | null, trailingUnstable?: number): ParseState;
```

```tsx
import { SyntaxStyle } from "@opentui/core";

const syntaxStyle = SyntaxStyle.create();

function StreamingMarkdown({ text, done }: { text: string; done: boolean }) {
  return <markdown content={text} syntaxStyle={syntaxStyle} streaming={!done} width="100%" />;
}
```

### 4.9 `<code>`

`CodeProps` — `components.d.ts:54`: `ComponentProps<CodeOptions, CodeRenderable>`.
`CodeOptions extends TextBufferOptions` — `core/renderables/Code.d.ts:9-35`:
```ts
export interface CodeOptions extends TextBufferOptions {
    content?: string;
    filetype?: string;
    syntaxStyle: SyntaxStyle;    // required
    treeSitterClient?: TreeSitterClient;
    conceal?: boolean;
    drawUnstyledText?: boolean;
    streaming?: boolean;
    initialStyledText?: StyledText;
    baseHighlight?: string;
    onHighlight?: OnHighlightCallback;
    onChunks?: OnChunksCallback;
}
```
Defaults (`Code.d.ts:60-65`): `conceal: true`, `drawUnstyledText: true`,
`streaming: false`. `style` excludes `content`/`filetype`/`syntaxStyle`/
`treeSitterClient`/`conceal`/`drawUnstyledText`. Ref: `React.Ref<CodeRenderable>`.

Also has `updateStreamingPreview(content, initialStyledText)` and async
`isHighlighting: boolean` / `highlightingDone: Promise<void>` for awaiting
tree-sitter highlight completion (`Code.d.ts:70,96-97`).

```tsx
<code content={fileContents} filetype="typescript" syntaxStyle={syntaxStyle} width="100%" height="100%" />
```

### 4.10 `<diff>`

`DiffProps` — `components.d.ts:57`: `ComponentProps<DiffRenderableOptions, DiffRenderable>`.
`DiffRenderableOptions` — `core/renderables/Diff.d.ts:8-33`:
```ts
export interface DiffRenderableOptions extends RenderableOptions<DiffRenderable> {
    diff?: string;                 // ONE unified-diff string, not separate old/new sides
    syncScroll?: boolean;
    view?: "unified" | "split";
    fg?: string | RGBA;
    filetype?: string;
    syntaxStyle?: SyntaxStyle;
    wrapMode?: "word" | "char" | "none";
    conceal?: boolean;
    selectionBg?: string | RGBA; selectionFg?: string | RGBA;
    treeSitterClient?: TreeSitterClient;
    showLineNumbers?: boolean;
    lineNumberFg?: string | RGBA; lineNumberBg?: string | RGBA;
    addedBg?: string | RGBA; removedBg?: string | RGBA; contextBg?: string | RGBA;
    addedContentBg?: string | RGBA; removedContentBg?: string | RGBA; contextContentBg?: string | RGBA;
    addedSignColor?: string | RGBA; removedSignColor?: string | RGBA;
    addedLineNumberBg?: string | RGBA; removedLineNumberBg?: string | RGBA;
}
```
Takes exactly one `diff` prop — a standard unified-diff text blob (the
package depends on the `diff` npm package to parse it). `view: "unified" |
"split"` is the exact literal union. Ref: `React.Ref<DiffRenderable>`.

Imperative-only methods (via ref, not in options):
`setLineColor(line, color)`, `clearLineColor(line)`, `setLineColors(map)`,
`clearAllLineColors()`, `highlightLines(start, end, color)`,
`clearHighlightLines(start, end)`, `getHunkRowOffsets(): number[]`
(`Diff.d.ts:138-144`).

```tsx
<diff diff={unifiedDiffText} view="split" filetype="typescript" showLineNumbers />
```

### 4.11 `<line-number>`

`LineNumberProps` — `components.d.ts:72-74`:
```ts
export type LineNumberProps = ComponentProps<ContainerProps<LineNumberOptions>, LineNumberRenderable> & { focused?: boolean; };
```
`LineNumberOptions` — `core/renderables/LineNumberRenderable.d.ts:5-27`:
```ts
export interface LineSign { before?: string; beforeColor?: string | RGBA; after?: string; afterColor?: string | RGBA; }
export interface LineColorConfig { gutter?: string | RGBA; content?: string | RGBA; }
export interface LineNumberOptions extends RenderableOptions<LineNumberRenderable> {
    target?: Renderable & LineInfoProvider;
    fg?: string | RGBA; bg?: string | RGBA;
    minWidth?: number;
    paddingRight?: number;
    lineColors?: Map<number, string | RGBA | LineColorConfig>;
    lineSigns?: Map<number, LineSign>;
    lineNumberOffset?: number;
    hideLineNumbers?: Set<number>;
    lineNumbers?: Map<number, number>;
    showLineNumbers?: boolean;
}
```
`children?: React.ReactNode` (from `ContainerProps`) — wraps a `<code>` (or
any `Renderable & LineInfoProvider`) as its content. Ref:
`React.Ref<LineNumberRenderable>`. Imperative-only: `setLineColor`/
`setLineSign`/`highlightLines`/etc.

```tsx
import { useRef, useEffect } from "react";
import type { LineNumberRenderable } from "@opentui/core";

function AnnotatedCode({ content }: { content: string }) {
  const ref = useRef<LineNumberRenderable>(null);
  useEffect(() => {
    ref.current?.setLineSign(4, { before: "!", beforeColor: "#f59e0b" });
  }, []);
  return (
    <line-number ref={ref} fg="#6b7280" showLineNumbers width="100%" height="100%">
      <code content={content} filetype="typescript" syntaxStyle={syntaxStyle} width="100%" height="100%" />
    </line-number>
  );
}
```

### 4.12 `<ascii-font>`

`AsciiFontProps` — `components.d.ts:66`: `ComponentProps<ASCIIFontOptions, ASCIIFontRenderable>`.
`ASCIIFontOptions` — `core/renderables/ASCIIFont.d.ts:7-15`:
```ts
export interface ASCIIFontOptions extends Omit<RenderableOptions<ASCIIFontRenderable>, "width" | "height"> {
    text?: string;
    font?: ASCIIFontName;               // "tiny"|"block"|"shade"|"slick"|"huge"|"grid"|"pallet"
    color?: ColorInput | ColorInput[];
    backgroundColor?: ColorInput;
    selectionBg?: ColorInput; selectionFg?: ColorInput;
    selectable?: boolean;
}
```
`ASCIIFontName` union — `core/lib/ascii.font.d.ts:3`. Default font `"tiny"`.
`width`/`height` are omitted (derived from rendered glyphs). Ref:
`React.Ref<ASCIIFontRenderable>`.

```tsx
<ascii-font text="KORTIX" font="block" color="#00ff88" />
```

### 4.13 `<image>`

`ImageProps` — `components.d.ts:55`: `ComponentProps<ImageRenderableOptions, ImageRenderable>`.
`ImageRenderableOptions` — `core/renderables/Image.d.ts:5-13`:
```ts
export type ImageFit = "fit" | "cover" | "fill";
export type ImageRenderableSource = ImageSource | NativeImage;   // ImageSource = string|URL|Uint8Array|ArrayBuffer|Blob|Response
export interface ImageRenderableOptions extends RenderableOptions<ImageRenderable> {
    source?: ImageRenderableSource;
    fit?: ImageFit;
    protocol?: ImageRenderProtocol;    // "auto"|"kitty"|"sixel"|"blocks"
    onLoad?: (image: NativeImage) => void;
    onError?: (error: unknown) => void;
}
```
`style` excludes `source`. Ref: `React.Ref<ImageRenderable>`.

```tsx
<image source="./logo.png" fit="cover" width={20} height={10} />
```

### 4.14 Not built-in: `<slider>`, `<scrollbar>`, `<text-table>`, `<embedded-terminal>`

These core classes exist but have no default JSX tag. Register with
`extend()` + a module augmentation of `OpenTUIComponents`
(`react/src/types/components.d.ts:76-90`), following the README's documented
pattern (`react/README.md:997-1062`):

```tsx
import { SliderRenderable, type SliderOptions } from "@opentui/core";
import { extend } from "@opentui/react";

declare module "@opentui/react" {
  interface OpenTUIComponents {
    slider: typeof SliderRenderable;
  }
}
extend({ slider: SliderRenderable });

// now usable:
// <slider orientation="horizontal" value={50} min={0} max={100} onChange={setValue} />
```

**`SliderOptions`** (`core/renderables/Slider.d.ts:5-14`):
```ts
export interface SliderOptions extends RenderableOptions<SliderRenderable> {
    orientation: "vertical" | "horizontal";   // required
    value?: number; min?: number; max?: number;
    viewPortSize?: number;
    backgroundColor?: ColorInput; foregroundColor?: ColorInput;
    onChange?: (value: number) => void;   // direct options callback (unlike Select/Input)
}
```
No `step` option exists anywhere in the type.

**`ScrollBarOptions`** (`core/renderables/ScrollBar.d.ts:7-13`) — normally
configured indirectly via `<scrollbox>`'s `scrollbarOptions`/
`verticalScrollbarOptions`/`horizontalScrollbarOptions`, not as a standalone
tag:
```ts
export interface ScrollBarOptions extends RenderableOptions<ScrollBarRenderable> {
    orientation: "vertical" | "horizontal";
    showArrows?: boolean;
    arrowOptions?: Omit<ArrowOptions, "direction">;
    trackOptions?: Partial<SliderOptions>;
    onChange?: (position: number) => void;
}
```
Visibility: `get/set visible(): boolean`, `resetVisibilityControl()`
(`ScrollBar.d.ts:28-30`) — auto-shows/hides based on whether content overflows
the viewport unless set manually.

**`TextTableOptions`** (`core/renderables/TextTable.d.ts:12-34`):
```ts
export type TextTableContent = (TextChunk[] | null | undefined)[][];
export interface TextTableOptions extends RenderableOptions<TextTableRenderable> {
    content?: TextTableContent;
    wrapMode?: "none" | "char" | "word";
    columnWidthMode?: "content" | "full";
    columnFitter?: "proportional" | "balanced";
    cellPadding?: number; cellPaddingX?: number; cellPaddingY?: number;
    columnGap?: number;
    showBorders?: boolean; border?: boolean; outerBorder?: boolean;
    selectable?: boolean;
    selectionBg?: ColorInput; selectionFg?: ColorInput;
    borderStyle?: BorderStyle; borderColor?: ColorInput; borderBackgroundColor?: ColorInput;
    backgroundColor?: ColorInput; fg?: ColorInput; bg?: ColorInput;
    attributes?: number;
}
```

**`EmbeddedTerminalOptions`** (`core/renderables/EmbeddedTerminal.d.ts:6-15`)
— see §4.15 for the full I/O model:
```ts
export interface EmbeddedTerminalOptions extends RenderableOptions<EmbeddedTerminalRenderable> {
    cols?: number; rows?: number;
    maxScrollback?: number;
    onData?: (data: Uint8Array, source: "input" | "response") => void;
    onTerminalResize?: (cols: number, rows: number) => void;
    onScreenChange?: () => void;
    selectable?: boolean;
}
```

### 4.15 EmbeddedTerminal I/O model — how you feed it bytes

`EmbeddedTerminalRenderable` (`core/renderables/EmbeddedTerminal.d.ts:6-67`)
is a **headless VT screen-buffer emulator, not a PTY**. It does not spawn a
process. Full public surface:
```ts
class EmbeddedTerminalRenderable extends Renderable {
    constructor(ctx: RenderContext, options: EmbeddedTerminalOptions);
    get/set onData(): ((data: Uint8Array, source: "input"|"response") => void) | undefined;
    get/set onTerminalResize(): ((cols: number, rows: number) => void) | undefined;
    get/set onScreenChange(): (() => void) | undefined;
    screen(): EmbeddedTerminalScreen;      // { text; lines: string[]; columns; rows; cursor: {x,y,visible} }
    write(data: string | Uint8Array): void;   // feed subprocess OUTPUT into the local screen buffer
    invalidate(): void;
    encodeKey(key: KeyEvent): Uint8Array;      // convert a local key event to escape-sequence bytes
    encodePaste(bytes: Uint8Array): Uint8Array;
    handleKeyPress(key: KeyEvent): boolean;
    handlePaste(event: PasteEvent): void;
}
```
Wiring pattern (this project — Kortix TUI's PTY panel, per `SPEC.md`, drives
a real remote PTY over WebSocket — `getKortixPtyWebSocketUrl`):
1. Spawn/connect the real process (e.g. via a WebSocket to the sandbox PTY).
2. Pipe process stdout → `terminalRef.current.write(bytes)`.
3. Set `onData={(bytes, source) => ws.send(bytes)}` — both `"input"` (local
   keystrokes, already escape-encoded via `encodeKey`/`encodePaste`) and
   `"response"` (VT replies like cursor-position reports) must be forwarded
   back to the driving process.
4. On container resize, forward `onTerminalResize={(cols, rows) =>
   ws.send(resizeMessage(cols, rows))}` to keep the real PTY's size in sync.

```tsx
import { useRef } from "react";
import type { EmbeddedTerminalRenderable } from "@opentui/core";
// registered per §4.14

function PtyPanel({ ws }: { ws: WebSocket }) {
  const ref = useRef<EmbeddedTerminalRenderable>(null);
  ws.onmessage = (e) => ref.current?.write(new Uint8Array(e.data));
  return (
    <embedded-terminal
      ref={ref}
      cols={80}
      rows={24}
      onData={(bytes) => ws.send(bytes)}
      onTerminalResize={(cols, rows) => ws.send(JSON.stringify({ resize: { cols, rows } }))}
    />
  );
}
```

---

## 5. Styling

### 5.1 Colors

`core/lib/RGBA.d.ts` — full surface:
```ts
export type ColorInput = string | RGBA;
export declare class RGBA {
    static fromArray(array: Uint16Array): RGBA;
    static fromValues(r: number, g: number, b: number, a?: number): RGBA;   // 0–1 float
    static fromInts(r: number, g: number, b: number, a?: number): RGBA;     // 0–255 int
    static fromHex(hex: string): RGBA;
    static fromIndex(index: number, snapshot?: ColorInput): RGBA;
    static defaultForeground(snapshot?: ColorInput): RGBA;
    static defaultBackground(snapshot?: ColorInput): RGBA;
    toInts(): [number, number, number, number];
    get r(): number; get g(): number; get b(): number; get a(): number;    // 0–1 float
    get intent(): ColorIntent;   // "rgb" | "indexed" | "default"
    toString(): string;
    equals(other?: RGBA): boolean;
}
export declare function normalizeColorValue(value: ColorInput | null | undefined): NormalizedColorValue | null;
export declare function hexToRgb(hex: string): RGBA;
export declare function rgbToHex(rgb: RGBA): string;
export declare function hsvToRgb(h: number, s: number, v: number): RGBA;
export declare function parseColor(color: ColorInput): RGBA;
```
`.fromValues()` takes **0–1 float** components; `.fromInts()` takes **0–255
integer** components (implementation, `core/chunk-node-70eg2nhg.js:1226-1330`
— not stated by the `.d.ts` itself). `.r/.g/.b/.a` getters return the 0–1
float representation.

**`parseColor` accepted string formats** (implementation,
`core/chunk-node-70eg2nhg.js:1319-1330` — the `.d.ts` only says
`ColorInput = string | RGBA`):
```js
function parseColor2(color) {
  if (typeof color === "string") {
    if (color.toLowerCase() === "transparent") return RGBA.fromValues(0,0,0,0);
    if (CSS_COLOR_NAMES[color.toLowerCase()]) return hexToRgb(CSS_COLOR_NAMES[color.toLowerCase()]);
    return hexToRgb(color);
  }
  return color;
}
```
So `parseColor` accepts: an `RGBA` instance (pass-through), the literal
`"transparent"`, any of a fixed **24-name CSS color table**
(`black,white,red,green,blue,yellow,cyan,magenta,silver,gray,grey,maroon,
olive,lime,aqua,teal,navy,fuchsia,purple,orange,brightblack,brightred,
brightgreen,brightblue,brightyellow,brightcyan,brightmagenta,brightwhite`,
case-insensitive), or **any hex string** (`#RGB`, `#RGBA`, `#RRGGBB`,
`#RRGGBBAA`, leading `#` optional). **`rgb(...)`/`rgba(...)` CSS-function
syntax is NOT supported** — only hex and the fixed name table.

`hexToRgb`/`rgbToHex`/`hsvToRgb` are exported for programmatic color math.
`RGBA.fromIndex(index, snapshot?)` resolves an ANSI-256 palette index,
optionally against a detected terminal palette snapshot
(`renderer.getPalette()`, §1.3).

```tsx
<box backgroundColor="#101418" borderColor="brightblack">
  <text fg="#e6e6e6" bg="transparent">Hex or named colors both work</text>
</box>
```

### 5.2 Borders

`core/lib/border.d.ts` — full surface:
```ts
export type BorderStyle = "single" | "double" | "rounded" | "heavy";
export type BorderSides = "top" | "right" | "bottom" | "left";
export interface BorderCharacters {
    topLeft: string; topRight: string; bottomLeft: string; bottomRight: string;
    horizontal: string; vertical: string;
    topT: string; bottomT: string; leftT: string; rightT: string; cross: string;
}
export declare const BorderChars: Record<BorderStyle, BorderCharacters>;
export declare function isValidBorderStyle(value: unknown): value is BorderStyle;
export declare function parseBorderStyle(value: unknown, fallback?: BorderStyle): BorderStyle;
export declare function getBorderFromSides(sides: BorderSidesConfig): boolean | BorderSides[];
export declare function getBorderSides(border: boolean | BorderSides[]): BorderSidesConfig;
```
Exactly 4 `BorderStyle` values — no `"none"`/`"ascii"` variant. `border` is
either `boolean` (all 4 sides) or a subset array `BorderSides[]`. **One
`borderColor` for the whole border**, not per-side — use
`customBorderChars: BorderCharacters` to override glyphs, or compose two
overlapping boxes if truly per-side colors are needed.

```tsx
<box border={["top", "bottom"]} borderStyle="double" borderColor="#00ffaa" />
```

### 5.3 Layout — flex, sizing, position, overflow

Settable layout options live on `Renderable`/`LayoutOptions`
(`core/Renderable.d.ts:29-87`), quoted in full:
```ts
export interface LayoutOptions extends BaseRenderableOptions {
    flexGrow?: number;
    flexShrink?: number;
    flexDirection?: "column" | "column-reverse" | "row" | "row-reverse";
    flexWrap?: "no-wrap" | "wrap" | "wrap-reverse";
    alignItems?: "auto"|"flex-start"|"center"|"flex-end"|"stretch"|"baseline"|"space-between"|"space-around"|"space-evenly";
    justifyContent?: "flex-start"|"center"|"flex-end"|"space-between"|"space-around"|"space-evenly";
    alignSelf?: /* same union as alignItems */;
    flexBasis?: number | "auto" | undefined;
    position?: "static" | "relative" | "absolute";
    overflow?: "visible" | "hidden" | "scroll";
    top?: number | "auto" | `${number}%`;
    right?: number | "auto" | `${number}%`;
    bottom?: number | "auto" | `${number}%`;
    left?: number | "auto" | `${number}%`;
    minWidth?: number | "auto" | `${number}%`;
    minHeight?: number | "auto" | `${number}%`;
    maxWidth?: number | "auto" | `${number}%`;
    maxHeight?: number | "auto" | `${number}%`;
    margin?: number | "auto" | `${number}%`;
    marginX?/marginY?/marginTop?/marginRight?/marginBottom?/marginLeft?: number | "auto" | `${number}%`;
    padding?: number | `${number}%`;
    paddingX?/paddingY?/paddingTop?/paddingRight?/paddingBottom?/paddingLeft?: number | `${number}%`;
    enableLayout?: boolean;
}
```
Plus, from `RenderableOptions<T>`: `width?/height?: number | "auto" |
\`${number}%\``, `zIndex?: number`, `visible?: boolean`, `opacity?: number`.

**Notable gaps** (verified absent, not omitted from this doc by accident):
- **`padding` does NOT accept `"auto"`** (`number | \`${number}%\`` only) —
  margin does accept `"auto"`. Intentional flexbox-consistent asymmetry.
- **No `gap`/`rowGap`/`columnGap` on the generic `LayoutOptions`/
  `RenderableOptions`.** `gap`/`rowGap`/`columnGap` DO exist, but only as
  `BoxOptions`-specific fields (`core/renderables/Box.d.ts:21-23`) — i.e.
  `<box>` supports `gap`, but it is not a universal layout prop on every
  renderable.
- **No `display` prop** (`"flex"|"none"|"contents"` exists as a yoga-level
  type in `lib/yoga.options.d.ts` but is not wired into `LayoutOptions`).

**`position: "absolute"` for overlays/modals**: set `position="absolute"`
plus `top`/`left`/`right`/`bottom` and a `zIndex` higher than sibling
content. `zIndex` (`core/Renderable.d.ts:211-212`) controls paint order across
all renderables sharing a parent stack.

```tsx
<box style={{ position: "relative", width: "100%", height: "100%" }}>
  <box style={{ flexGrow: 1 }}>{/* main content */}</box>

  {showModal && (
    <box
      style={{
        position: "absolute",
        top: "20%",
        left: "20%",
        width: "60%",
        height: "60%",
        zIndex: 100,
        border: true,
        backgroundColor: "#101418",
      }}
    >
      <text>Modal content</text>
    </box>
  )}
</box>
```

### 5.4 `visible`, `overflow`, `opacity`

`get/set visible(): boolean` (base `BaseRenderable`, `Renderable.d.ts:113-114,
167-169`). `get/set overflow(): "visible"|"hidden"|"scroll"`
(`Renderable.d.ts:219-220`). `get/set opacity(): number`
(`Renderable.d.ts:170-171`), clamped `[0,1]` at runtime (implementation,
`core/chunk-node-54dhb2fr.js:501-508`).

### 5.5 Text attributes

`TextAttributes` — `core/types.d.ts:7-17` (bit values from implementation,
`core/chunk-node-70eg2nhg.js:4552-4562`, not shown in the `.d.ts` itself):
```ts
export declare const TextAttributes: {
    NONE: number;          // 0
    BOLD: number;           // 1
    DIM: number;            // 2
    ITALIC: number;         // 4
    UNDERLINE: number;      // 8
    BLINK: number;          // 16
    INVERSE: number;        // 32
    HIDDEN: number;         // 64
    STRIKETHROUGH: number;  // 128
};
```
Set via the numeric `attributes?: number` field present on `TextBufferOptions`
/`TextNodeOptions`/`EditBufferOptions` etc. — combine with bitwise OR:
`attributes: TextAttributes.BOLD | TextAttributes.UNDERLINE`.

### 5.6 `StyledText` and the `t` tag

`core/lib/styled-text.d.ts` — full surface:
```ts
export interface StyleAttrs {
    fg?: Color; bg?: Color; bold?: boolean; italic?: boolean; underline?: boolean;
    strikethrough?: boolean; dim?: boolean; reverse?: boolean; blink?: boolean;
}
export declare class StyledText {
    chunks: TextChunk[];
    constructor(chunks: TextChunk[]);
}
export declare function stringToStyledText(content: string): StyledText;
export type StylableInput = string | number | boolean | TextChunk;
// One helper per named color / style, each: (input: StylableInput) => TextChunk
export declare const black/red/green/yellow/blue/magenta/cyan/white: (input: StylableInput) => TextChunk;
export declare const brightBlack/brightRed/.../brightWhite: (input: StylableInput) => TextChunk;
export declare const bgBlack/bgRed/.../bgWhite: (input: StylableInput) => TextChunk;
export declare const bold/italic/underline/strikethrough/dim/reverse/blink: (input: StylableInput) => TextChunk;
export declare const fg: (color: Color) => (input: StylableInput) => TextChunk;
export declare const bg: (color: Color) => (input: StylableInput) => TextChunk;
export declare const link: (url: string) => (input: StylableInput) => TextChunk;
/**
 * Template literal handler for styled text (non-cached version).
 * Returns a StyledText object containing chunks of text with optional styles.
 */
export declare function t(strings: TemplateStringsArray, ...values: StylableInput[]): StyledText;
```
`TextChunk` (`core/text-buffer.d.ts:6-15`):
```ts
export interface TextChunk {
    __isChunk: true;
    text: string;
    fg?: RGBA; bg?: RGBA;
    attributes?: number;
    link?: { url: string };
}
```
Compose spans by nesting style-helper calls inside a `t\`...\`` template;
`fg(color)`/`bg(color)` are curried factories accepting any `ColorInput`
(not just the 16 named ANSI helpers).

```tsx
import { t, bold, fg } from "@opentui/core";

const styled = t`Status: ${bold(fg("#22c55e")("OK"))}`;
// <text content={styled} />
```

---

## 6. Refs

Ref typing is uniform (`react/src/types/components.d.ts:6-9`):
```ts
export type ReactProps<TRenderable = unknown> = {
    key?: React.Key;
    ref?: React.Ref<TRenderable>;
};
```
Every intrinsic element's `ref` targets the **core renderable class itself**
— `@opentui/react` never defines parallel handle types. Import the class from
`@opentui/core`:

| JSX tag | `ref` type |
|---|---|
| `box` | `React.Ref<BoxRenderable>` |
| `text` | `React.Ref<TextRenderable>` |
| `span`/`b`/`strong`/`i`/`em`/`u`/`a` | `React.Ref<TextNodeRenderable>` |
| `br` | none — `LineBreakProps = Pick<SpanProps, "id">` has no `ref` field |
| `input` | `React.Ref<InputRenderable>` |
| `textarea` | `React.Ref<TextareaRenderable>` |
| `select` | `React.Ref<SelectRenderable>` |
| `tab-select` | `React.Ref<TabSelectRenderable>` |
| `scrollbox` | `React.Ref<ScrollBoxRenderable>` |
| `code` | `React.Ref<CodeRenderable>` |
| `markdown` | `React.Ref<MarkdownRenderable>` |
| `diff` | `React.Ref<DiffRenderable>` |
| `line-number` | `React.Ref<LineNumberRenderable>` |
| `ascii-font` | `React.Ref<ASCIIFontRenderable>` |
| `image` | `React.Ref<ImageRenderable>` |

For `extend()`-registered custom components, the ref type is
`React.Ref<ExtractRenderable<TConstructor>>`, where `ExtractRenderable`
(`components.d.ts:15`) pulls the instance type off the constructor passed to
`extend()`.

```tsx
import { useRef } from "react";
import type { TextareaRenderable } from "@opentui/core";

function Composer() {
  const ref = useRef<TextareaRenderable>(null);
  return <textarea ref={ref} placeholder="Type here..." focused />;
}
```

---

## 7. Hooks (`@opentui/react`)

All hooks are barreled from `react/src/hooks/index.d.ts:1-9` and re-exported
via `react/src/index.d.ts`.

### 7.1 `useRenderer`

`react/src/hooks/use-renderer.d.ts:1`:
```ts
export declare const useRenderer: () => import("@opentui/core").CliRenderer;
```
No parameters. Returns the live `CliRenderer` singleton.
```tsx
const renderer = useRenderer();
renderer.console.show();
```

### 7.2 `useKeyboard`

`react/src/hooks/use-keyboard.d.ts:1-22`:
```ts
export interface UseKeyboardOptions {
    /** Include release events - callback receives events with eventType: "release" */
    release?: boolean;
}
/**
 * Subscribe to keyboard events.
 *
 * By default, only receives press events (including key repeats with `repeated: true`).
 * Use `options.release` to also receive release events.
 */
export declare const useKeyboard: (handler: (key: KeyEvent) => void, options?: UseKeyboardOptions) => void;
```
Subscribes at the global level (§2.4). Callback param is core's `KeyEvent`.
```tsx
useKeyboard((key) => {
  if (key.name === "escape") closeModal();
}, { release: false });
```

### 7.3 `useOnResize`

`react/src/hooks/use-resize.d.ts:1`:
```ts
export declare const useOnResize: (callback: (width: number, height: number) => void) => import("@opentui/core").CliRenderer;
```
Returns the `CliRenderer` (unusual — most hooks return `void`); the README
usage ignores the return value.
```tsx
useOnResize((width, height) => setLayout(width, height));
```

### 7.4 `useTerminalDimensions`

`react/src/hooks/use-terminal-dimensions.d.ts:1-4`:
```ts
export declare const useTerminalDimensions: () => { width: number; height: number; };
```
```tsx
const { width, height } = useTerminalDimensions();
```

### 7.5 `usePaste`

`react/src/hooks/use-paste.d.ts:1-10`:
```ts
export declare const usePaste: (handler: (event: PasteEvent) => void) => void;
```
`PasteEvent.bytes: Uint8Array` — decode with `decodePasteBytes` from
`@opentui/core` (the hook's own JSDoc example uses `event.text`, which does
not exist on `PasteEvent` — a doc bug in the package; use `.bytes`).
```tsx
import { decodePasteBytes } from "@opentui/core";
usePaste((event) => {
  const text = decodePasteBytes(event.bytes);
  insertAtCursor(text);
});
```

### 7.6 `useFocus` / `useBlur`

`react/src/hooks/use-focus.d.ts:1-10`, `use-blur.d.ts:1-10`:
```ts
/** Subscribe to terminal window focus events. Fires when the terminal window gains focus. */
export declare const useFocus: (handler: () => void) => void;
/** Subscribe to terminal window blur events. Fires when the terminal window loses focus. */
export declare const useBlur: (handler: () => void) => void;
```
**These are terminal-window (OS-level) focus events, not component focus.**
Handlers take no arguments. Element-level focus is the plain controlled
`focused?: boolean` prop on `box`/`input`/`textarea`/`select`/`scrollbox`/
`tab-select`/`line-number` (§3) — hold your own "active field" state:
```tsx
const [active, setActive] = useState<"username" | "password">("username");
useKeyboard((key) => {
  if (key.name === "tab") setActive((p) => (p === "username" ? "password" : "username"));
});
// ...
<input focused={active === "username"} ... />
<input focused={active === "password"} ... />
```

### 7.7 `useSelectionHandler`

`react/src/hooks/use-selection.d.ts:1-12`:
```ts
export declare const useSelectionHandler: (handler: (selection: Selection) => void) => void;
```
`Selection` (`core/lib/selection.d.ts:4-44`) key members: `getSelectedText():
string`, `get bounds(): ViewportBounds`, `get selectedRenderables():
Renderable[]`.
```tsx
useSelectionHandler((selection) => {
  console.log("Selected:", selection.getSelectedText());
});
```

### 7.8 `useTimeline`

`react/src/hooks/use-timeline.d.ts:1-2`:
```ts
export declare const useTimeline: (options?: TimelineOptions) => Timeline;
```
`TimelineOptions` (`core/animation/Timeline.d.ts:2-8`): `{ duration?: number;
loop?: boolean; autoplay?: boolean; onComplete?: () => void; onPause?: () =>
void; }`. `Timeline.add(target, properties: AnimationOptions, startTime?:
number | string): this` — `AnimationOptions.ease?: EasingFunctions`, where
`EasingFunctions` is one of `linear`, `inQuad`, `outQuad`, `inOutQuad`,
`inExpo`, `outExpo`, `inOutSine`, `outBounce`, `outElastic`, `inBounce`,
`inCirc`, `outCirc`, `inOutCirc`, `inBack`, `outBack`, `inOutBack`.
```tsx
const timeline = useTimeline({ autoplay: true });
timeline.add(boxRef.current, { duration: 300, opacity: [0, 1] as any, ease: "outQuad" });
```

### 7.9 No `useKeymap`

Grepping the whole `@opentui/react` package for `useKeymap` finds nothing.
`@opentui/keymap` is only a **devDependency** in `react/package.json`, not a
runtime dependency or re-export — **not part of the public API in 0.5.11.**
Build a keymap table in app code (as `apps/tui/src/keymap.ts` per `SPEC.md`)
and dispatch off `useKeyboard`.

### 7.10 `extend` / component registry (not a hook, but the extension point used above)

`react/src/components/index.d.ts:41-42`:
```ts
export declare function extend<T>(objects: T): void;
export declare function getComponentCatalogue(): ComponentCatalogue;
```
See §4.14 for the full registration pattern.

### 7.11 `AppContext` / `useAppContext`

`react/src/components/app.d.ts` (full):
```ts
interface AppContext { keyHandler: KeyHandler | null; renderer: CliRenderer | null; }
export declare const AppContext: import("react").Context<AppContext>;
export declare const useAppContext: () => AppContext;
```
Both fields nullable — presumably `null` before the root mounts.

---

## 8. Testing

### 8.1 `createTestRenderer` (core, `@opentui/core/testing`)

`core/testing.d.ts` barrels `test-renderer.js`, `mock-keys.js`,
`mock-mouse.js`, `mock-tree-sitter-client.js`, `terminal-capabilities.js`,
`spy.js` (all `export *`), plus named `ManualClock`, `TestRecorder`,
`RecordedFrame`.

`core/testing/test-renderer.d.ts:54`:
```ts
export declare function createTestRenderer(options: TestRendererOptions): Promise<TestRendererSetup>;
```
`TestRendererOptions` (`:6-11`) — extends `CliRendererConfig` (§1.2):
```ts
export interface TestRendererOptions extends CliRendererConfig {
    width?: number;
    height?: number;
    kittyKeyboard?: boolean;
    otherModifiersMode?: boolean;
}
```
`TestRendererSetup` (`:39-53`) — full return type:
```ts
export interface TestRendererSetup {
    renderer: TestRenderer;    // = CliRenderer (same class, full public API available)
    mockInput: MockInput;      // = ReturnType<typeof createMockKeys>
    mockMouse: MockMouse;      // = ReturnType<typeof createMockMouse>
    renderOnce: () => Promise<void>;
    flush: (options?: TestFlushOptions) => Promise<void>;                                     // { maxPasses?: number }
    waitFor: (predicate: () => boolean | Promise<boolean>, options?: TestWaitForOptions) => Promise<void>;
    waitForFrame: (predicate: (frame: string) => boolean | Promise<boolean>, options?: TestWaitForOptions) => Promise<string>;
    waitForVisualIdle: (options?: TestVisualIdleOptions) => Promise<void>;                     // { quietFrames?; maxFrames? }
    externalOutput: TestExternalOutput;   // { take(); takeText(): string; clear(): void }
    getNativeStats: () => NativeRenderStats;
    captureCharFrame: () => string;
    captureSpans: () => CapturedFrame;
    resize: (width: number, height: number) => void;
}
```
`CapturedFrame` (`core/types.d.ts:188-193`):
```ts
export interface CapturedFrame { cols: number; rows: number; cursor: [number, number]; lines: CapturedLine[]; }
export interface CapturedLine { spans: CapturedSpan[]; }
export interface CapturedSpan { text: string; fg: RGBA; bg: RGBA; attributes: number; width: number; }
```

### 8.2 `mock-keys` (`core/testing/mock-keys.d.ts`, full)

```ts
export declare function pasteBytes(text: string): Uint8Array;
export declare const KeyCodes: {
    RETURN: "\r"; LINEFEED: "\n"; TAB: "\t"; BACKSPACE: "\b"; DELETE: "[3~";
    HOME: "[H"; END: "[F"; ESCAPE: "";
    ARROW_UP: "[A"; ARROW_DOWN: "[B"; ARROW_RIGHT: "[C"; ARROW_LEFT: "[D";
    F1: "OP"; F2: "OQ"; F3: "OR"; F4: "OS";
    F5: "[15~"; F6: "[17~"; F7: "[18~"; F8: "[19~";
    F9: "[20~"; F10: "[21~"; F11: "[23~"; F12: "[24~";
};
export type KeyInput = string | keyof typeof KeyCodes;
export interface MockKeysOptions { kittyKeyboard?: boolean; otherModifiersMode?: boolean; }
export declare function createMockKeys(renderer: CliRenderer, options?: MockKeysOptions): {
    pressKeys: (keys: KeyInput[], delayMs?: number) => Promise<void>;
    pressKey: (key: KeyInput, modifiers?: { shift?: boolean; ctrl?: boolean; meta?: boolean; super?: boolean; hyper?: boolean }) => void;
    typeText: (text: string, delayMs?: number) => Promise<void>;
    pressEnter: (modifiers?) => void;
    pressEscape: (modifiers?) => void;
    pressTab: (modifiers?) => void;
    pressBackspace: (modifiers?) => void;
    pressArrow: (direction: "up" | "down" | "left" | "right", modifiers?) => void;
    pressCtrlC: () => void;
    pasteBracketedText: (text: string) => Promise<void>;
};
```
**Note**: `KeyInput` names (`"RETURN"`, `"ARROW_UP"`, …) are `KeyCodes`
object keys — a different vocabulary from `ParsedKey.name` (`"return"`,
`"up"`, …). No `alt` field in the modifiers object (only `shift`/`ctrl`/
`meta`/`super`/`hyper`).

### 8.3 `ManualClock` (`core/testing/manual-clock.d.ts`, full)

```ts
export declare class ManualClock implements Clock {
    now(): number;
    setTime(time: number): void;
    setTimeout(fn: () => void, delayMs: number): TimerHandle;
    clearTimeout(handle: TimerHandle): void;
    setInterval(fn: () => void, delayMs: number): TimerHandle;
    clearInterval(handle: TimerHandle): void;
    advance(delayMs: number): void;   // fire due timers deterministically
    runAll(): void;                    // drain every pending timer
}
```
Pass into `CliRendererConfig.clock` (or any `{ clock?: Clock }` constructor,
e.g. `MockTreeSitterClient`) to control virtual time in tests instead of
waiting on wall-clock time.

### 8.4 `TestRecorder` (`core/testing/test-recorder.d.ts`)

```ts
export interface RecordBuffersOptions { fg?: boolean; bg?: boolean; attributes?: boolean; }
export interface RecordedFrame { frame: string; timestamp: number; frameNumber: number; buffers?: RecordedBuffers; }
export interface TestRecorderOptions { recordBuffers?: RecordBuffersOptions; now?: () => number; }
/**
 * TestRecorder records frames from a TestRenderer by listening to rendered frame events.
 * It captures the character frame after each native render pass.
 */
export declare class TestRecorder {
    constructor(renderer: TestRenderer, options?: TestRecorderOptions);
    rec(): void;
    stop(): void;
    get recordedFrames(): RecordedFrame[];
    clear(): void;
    get isRecording(): boolean;
}
```
Records **character frames only** — no key/mouse input events. Import from
`@opentui/core/testing/test-recorder` for the extra option types
(`RecordBuffersOptions`, `RecordedBuffers`, `TestRecorderOptions` are not
re-exported by the `testing.d.ts` barrel, only `TestRecorder`/`RecordedFrame`
are).

### 8.5 Terminal capabilities / test streams / spy (all `core/testing/*.d.ts`, full)

```ts
// terminal-capabilities.d.ts
export declare function createTerminalCapabilities(overrides?: TerminalCapabilitiesOverrides): TerminalCapabilities;
export declare function setRendererCapabilities(renderer: CliRenderer, overrides?: TerminalCapabilitiesOverrides): TerminalCapabilities;

// test-streams.d.ts
export declare function createTestStdin(): NodeJS.ReadStream;
export declare function createTestStdout(columns?: number, rows?: number): NodeJS.WriteStream;

// spy.d.ts
export declare function createSpy(): {
    (...args: any[]): void;
    calls: any[][];
    callCount(): number;
    calledWith(...expected: any[]): boolean;
    reset(): number;
};
```

### 8.6 `bun-test-node` — NOT in the `testing.d.ts` barrel

`core/testing/bun-test-node.d.ts` is a Bun/Node cross-runner shim (`expect`,
`mock`, `spyOn`, `beforeAll`/`afterAll`/`test`/`it`/`describe`, Jest-style
matchers). It is **not re-exported from `@opentui/core/testing`** — import it
from `@opentui/core/testing/bun-test-node` directly if needed. For `apps/tui`
(Bun-only, per `SPEC.md`), prefer `bun:test` directly instead.

### 8.7 `@opentui/react/test-utils` — `testRender`

`react/src/test-utils.d.ts` (full, 3 lines):
```ts
import { type TestRendererOptions } from "@opentui/core/testing";
import { type ReactNode } from "react";
export declare function testRender(
  node: ReactNode,
  testRendererOptions: TestRendererOptions   // required, not optional
): Promise<import("@opentui/core/testing").TestRendererSetup>;
```
Returns **exactly** core's `TestRendererSetup` — no React-specific additions
(no `unmount`/`rerender` in this version's declared type). It mounts `node`
via the React reconciler onto a `createTestRenderer(testRendererOptions)`
instance and returns that same setup object.

### 8.8 Example 1 — render `<box><text>Hello</text></box>` and assert the frame

```ts
// hello.test.ts
import { test, expect } from "bun:test";
import { testRender } from "@opentui/react/test-utils";

test("renders Hello inside a box", async () => {
  const { captureCharFrame, captureSpans, renderOnce } = await testRender(
    <box>
      <text>Hello</text>
    </box>,
    { width: 40, height: 10 },
  );

  await renderOnce();

  expect(captureCharFrame()).toContain("Hello");

  const spans = captureSpans();
  const allText = spans.lines.flatMap((l) => l.spans.map((s) => s.text)).join("");
  expect(allText).toContain("Hello");
});
```

### 8.9 Example 2 — type into a focused `<input>` via mock-keys

```ts
// input-typing.test.ts
import { test, expect } from "bun:test";
import { testRender } from "@opentui/react/test-utils";

test("typing into a focused input updates the rendered frame", async () => {
  const { mockInput, renderOnce, captureCharFrame } = await testRender(
    <input placeholder="Type here" focused />,   // `focused` prop grants focus declaratively
    { width: 40, height: 10 },
  );

  await renderOnce();

  await mockInput.typeText("hello");
  await renderOnce();

  expect(captureCharFrame()).toContain("hello");
});
```
**Unverified**: whether `focused` (a controlled JSX prop, §3) reliably grants
native focus *before* the first `renderOnce()` in a test harness, versus
needing a `waitFor`/extra render pass first, was not confirmed against a real
run — if this flakes, add `await renderOnce()` twice, or assert via
`setup.renderer.currentFocusedRenderable` before typing. Do not invent an
alternative API (e.g. `getByPlaceholder`) — none exists in these `.d.ts`
files.

---

## 9. Lifecycle / gotchas

### 9.1 Alternate screen

No `alternateScreen`/`useAlternateScreen` field exists — the concept is
`CliRendererConfig.screenMode?: "alternate-screen" | "main-screen" |
"split-footer"` (`core/renderer.d.ts:48,60`). Default `"alternate-screen"`
(implementation, `core/chunk-node-54dhb2fr.js:6852-6855`), overridable via
config or the env var `OTUI_USE_ALTERNATE_SCREEN` (boolean). Runtime setter:
`renderer.screenMode = "main-screen"` re-applies live.

### 9.2 Cursor visibility / style

```ts
setCursorPosition(x: number, y: number, visible?: boolean): void;   // core/renderer.d.ts:572
setCursorStyle(options: CursorStyleOptions): void;                   // :573
setCursorColor(color: RGBA): void;                                   // :574
getCursorState(): import("./zig.js").CursorState;                    // :575
```
`CursorStyleOptions` (`core/types.d.ts:37-42`): `{ style?: "block"|"line"|
"underline"|"default"; blinking?: boolean; color?: RGBA; cursor?:
MousePointerStyle }`. Both `static` and instance forms exist.

### 9.3 `process.exit` vs `renderer.destroy()` — real gotcha

`destroy()` (implementation, `core/chunk-node-54dhb2fr.js:9791-9900`) does
full terminal teardown: exits raw mode, pauses stdin, removes every
`process.on(...)` listener the constructor added, disables mouse reporting,
resets the terminal background color, emits `"destroy"`.

**`destroy()` never calls `process.exit()`.** Grep of both bundled chunk files
for `process.exit(` returns zero matches. The `exitOnCtrlC`/`exitSignals`
handlers likewise only call `this.destroy()`, never `process.exit()`.
**Registering a listener for `SIGINT`/`SIGTERM` overrides Node/Bun's default
terminate-on-signal behavior** — so an app whose only signal handling comes
from this library will not automatically end the process on Ctrl+C/`kill`
unless something else (natural event-loop drain, or explicit app code) makes
it exit. **Always call `renderer.destroy()` on every shutdown path, and verify
empirically per-app that the process actually terminates afterward** — do not
assume it does.

### 9.4 Terminal restore on crash

`process.on("uncaughtException"/"unhandledRejection", handleError)` is
registered in the constructor. `handleError` (implementation,
`core/chunk-node-54dhb2fr.js:7291-7295`):
```js
handleError = (error) => {
  console.error(error);
  if (this._openConsoleOnError) this.console.show();
};
```
**`handleError` does not call `destroy()`.** On an uncaught exception, the
terminal is NOT automatically restored — only the console overlay opens (if
`openConsoleOnError`, default `true`) and the error is logged. Whether the
runtime's own crash-exit path leaves the terminal in a broken state (no raw
mode restore, alternate screen not exited) is a real risk; wrap your own
top-level `process.on("uncaughtException", () => renderer.destroy())` if this
matters for your app, since the library does not do it for you.

### 9.5 Mouse support

`CliRendererConfig.useMouse?: boolean` (default `true`) and
`enableMouseMovement?: boolean` (default `true`) — `core/renderer.d.ts:45-46`.
Runtime toggle: `renderer.useMouse` get/set (`:438-439`). `MouseEvent` class
(`core/renderer.d.ts:154-179`) has the same `preventDefault`/`stopPropagation`
surface as `KeyEvent`. `MouseButton` enum (`:184-190`): `LEFT=0, MIDDLE=1,
RIGHT=2, WHEEL_UP=4, WHEEL_DOWN=5`. Per-renderable handlers:
`onMouse`/`onMouseDown`/`onMouseUp`/`onMouseMove`/`onMouseDrag`/
`onMouseDragEnd`/`onMouseDrop`/`onMouseOver`/`onMouseOut`/`onMouseScroll` on
`RenderableOptions` (`core/Renderable.d.ts:74-83`). There is no `useMouse()`
React hook — mouse is core-level only in this version.

### 9.6 `setBackgroundColor`

`renderer.setBackgroundColor(color: ColorInput): void`
(`core/renderer.d.ts:550`) — sets the renderer's base background; also
settable at construction via `CliRendererConfig.backgroundColor`.

### 9.7 Threads / workers — tree-sitter parser worker

Syntax highlighting (`<code>`, `<markdown>`, `<diff>`) runs through
`TreeSitterClient` (`core/lib/tree-sitter/client.d.ts`), which spawns a
dedicated worker (`core/parser.worker.js`, compiled from
`lib/tree-sitter/parser.worker.d.ts` — the `.d.ts` itself exports nothing,
`export {};`) and communicates via a typed request/response protocol
(`core/lib/tree-sitter/types.d.ts:48-151`).

### 9.8 Tree-sitter assets — offline behavior

`web-tree-sitter` is a **peer dependency** (`react`/`core` `package.json`),
**not bundled** — install it yourself. **5 languages ship fully offline**:
`javascript`, `typescript`/`typescriptreact`, `markdown`, `markdown_inline`,
`zig` — their `.wasm` grammar + `.scm` query files are physically present
under `core/assets/{javascript,typescript,markdown,markdown_inline,zig}/`
(verified on disk) and resolved relative to the installed package, no network
required. **Any other filetype** needs either a local file passed to
`TreeSitterClient.addFiletypeParser()`, or a network fetch via
`DownloadUtils.downloadOrLoad`/`downloadToPath`/`fetchHighlightQueries`
(`core/lib/tree-sitter/download-utils.d.ts:6-21`), which **returns
`{error}` on failure rather than throwing** — a caller can detect an offline
failure and fall back gracefully (e.g. `CodeOptions.drawUnstyledText`
defaults `true`, so plain unhighlighted text still renders).
`update-assets.d.ts`/`assets/update.d.ts` is a **maintainer/build-time CLI**
for regenerating the bundled asset set — not an end-user runtime API; doc
comment (`core/lib/tree-sitter/parsers-config.d.ts:1-5`, verbatim):
```
/**
 * This file contains the configuration for the defaulttree-sitter parsers.
 * It is used by ./assets/update.ts to generate the default parser runtime files and asset manifest.
 * For changes here to be reflected in generated files, you need to run `bun run ./assets/update.ts`
 */
```

### 9.9 Bun vs Node

`core/README.md:50-58` (verbatim):
```
`@opentui/core` runs on Bun 1.3.0 or later, or on Node.js 26.4.0 or later with ECMAScript modules (ESM) and
`--experimental-ffi`.

Use Bun 1.4.0 or later on native Windows arm64.

The native ABI and the generated platform packages, such as `@opentui/core-linux-x64`, are internal distribution
surfaces, not application APIs.
```
`apps/tui` targets Bun exclusively (per `SPEC.md`) — the Node/`--experimental-ffi`
path is not exercised by this project.

### 9.10 Debug env vars (implementation-only, not typed)

Found only in the compiled JS, not in any `.d.ts` — informational, not a
typed contract: `OTUI_USE_CONSOLE`, `SHOW_CONSOLE`, `OTUI_STDIN_LOG`,
`OTUI_SHOW_STATS`, `OTUI_USE_ALTERNATE_SCREEN`, `OTUI_OVERRIDE_STDOUT`,
`OTUI_NO_NATIVE_RENDER`, `OTUI_DUMP_CAPTURES`, `OTUI_DEBUG`.

---

## Appendix: known documentation bugs in the package itself (not this doc)

- `react/src/hooks/use-paste.d.ts`'s own JSDoc example references
  `event.text`, which does not exist on `PasteEvent`
  (`core/lib/KeyHandler.d.ts:30-41` has `bytes: Uint8Array`, not `text`). Use
  `.bytes` + `decodePasteBytes`.
- `ErrorBoundary` (`react/src/components/error-boundary.d.ts`) is fully typed
  but **not re-exported** from `react/src/index.d.ts` — `import {
  ErrorBoundary } from "@opentui/react"` will not resolve in 0.5.11.
