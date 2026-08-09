# Enhance Chat Input — design

**Date:** 2026-08-09
**Branch:** `message-input`
**Surface:** `apps/web/src/features/session/` composer
**Linear:** project `Enhance Chat Input` (team Jay)

---

## 1. Problem

The session composer works, but it is one 1,383-line component that owns
everything. Three concrete consequences, each measured from the code:

### 1.1 Every keystroke re-renders the whole toolbar

`text` lives in `SessionChatInputImpl` alongside the toolbar
(`session-chat-input.tsx:298`). One `setText` therefore re-renders
`ComposerToolbar` and its six children: `AgentSelector`, `ModelSelector`,
`VariantSelector`, `ReasoningEffortSelector`, `TokenProgress`, `VoiceRecorder`,
plus `AttachmentPreview` and `QueuedMessages`.

The `memo()` at `session-chat-input.tsx:1382` cannot help. `memo` compares
*incoming props*; it does nothing about state changes originating inside the
component it wraps. The doc comment above it is correct about intent and wrong
about effect.

### 1.2 The composer re-renders while nobody is typing

`session-chat-input.tsx:435-445` runs a 6-second `setInterval` that increments
`placeholderIndex`, driving an `AnimatePresence` crossfade through 12 rotating
placeholder strings. While the composer is idle and empty, the entire subtree
above re-renders every 6 seconds, forever, in every mounted session tab.

### 1.3 Hand-rolled infrastructure that libraries already own

| Hand-rolled | Lines | Already available |
|---|---|---|
| File-search debounce + stale-response guard + result cache (`fileSearchTimer`, `fileSearchSeq`, `fileResultsCache`) | `session-chat-input.tsx:602-656` (~55) | TanStack Query `staleTime` + `placeholderData` (already a dependency) |
| Mention tracking as a parallel `TrackedMention[]` array kept in sync with a string by substring pruning | `:1038`, `:885-920` | A ProseMirror atom node — the document *is* the source of truth |
| Highlight overlay: transparent-text textarea + mirrored `<div>` that must match font metrics and wrapping | `:1274-1292` | Native rendering of a contentEditable |
| Popover positioning via `getBoundingClientRect()` **read during render** | `mention-popover.tsx:46`, `slash-command-popover.tsx:50` | Floating UI (`@floating-ui/dom`, already installed) |

### 1.4 Correctness bugs that fall out of the string model

- **Only the first occurrence of a mention highlights.** `highlightSegments`
  (`:1055-1080`) resolves each tracked mention with `text.indexOf(needle)`.
  Type `@README.md` twice and the second one renders as plain text.
- **Mention pruning is substring-based.** `:1038` keeps a mention alive if
  `val.includes('@' + m.label)`. Deleting one of two identical mentions removes
  neither from tracking.
- **`/` only triggers at position 0.** The regex is `/^\/(\S*)$/` (`:1002`), so
  a slash command is impossible after a newline or any preceding text.
- **Popovers do not reposition.** Because the rect is read during render and
  never recomputed, scrolling or resizing while a popover is open leaves it
  behind.

### 1.5 Effect inventory

Eight effects in the parent, twelve more across children.

| # | Location | Purpose | Disposition |
|---|---|---|---|
| 1 | `:349` | Imperative prefill from parent | **Keep** — external signal; becomes `setContent` |
| 2 | `:383` | Save/restore draft around `lockForQuestion` | **Keep**, move to a ref-based handler |
| 3 | `:398` | Type-anywhere → focus composer (window listener) | **Keep**, hoist to one app-level listener |
| 4 | `:435` | Rotating placeholder `setInterval` | **Delete** |
| 5 | `:451` | `focus-session-textarea` window listener | **Keep**, extract to hook |
| 6 | `:475` | autoFocus via `IntersectionObserver` | **Keep**, extract to hook |
| 7 | `:602` | Debounced file search + cache | **Replace** with TanStack Query |
| 8 | `:704` | Clamp `mentionIndex` when items change | **Delete** — derive during render |

Net: 8 → 4, and each survivor becomes a named single-purpose hook.

`agent-selector.tsx:48-59` additionally has two effects both writing
`prevAgentRef`. The first returns early on the flash path without updating the
ref; the second updates it unconditionally. They are order-dependent and one of
them is redundant.

---

## 2. Goals

1. Typing does not re-render anything outside the editor.
2. `@` inserts an atomic inline badge — one backspace deletes it whole, the
   caret cannot land inside it, and every occurrence renders identically.
3. `/` opens a two-section palette (Commands, Actions) and works at any caret
   position.
4. Markdown is supported: input rules while typing, and correct serialization
   on send.
5. `@` results come from a shared, revalidating cache — fresh skills and files
   without a per-composer `Set`.
6. Attachment tiles in the composer match the tiles in the sent message.
7. The visual language matches the Kortix design system and works from 320 px up.
8. Every behaviour in §7 survives.

## 3. Non-goals

- No change to the send wire format beyond mention serialization (§5.4).
- No change to the queue algorithm (`message-queue-boundary.ts`) — it is tested
  and correct.
- No new "advanced mode" toggle and no `…` overflow popover. Both were built and
  reverted before; `composer-toolbar.tsx:19-36` records why, and this design does
  not re-litigate it.
- No redesign of the transcript, the action panel, or the session header.

---

## 4. Architecture

### 4.1 State ownership

The single structural fix: **the editor owns its own text, and React never sees
a keystroke.**

```
ComposerChatInput                 ← selector wiring (unchanged responsibility)
└── Composer                      ← layout shell; holds NO text state
    ├── ComposerEditor            ← uncontrolled ProseMirror; owns the document
    │   ├── MentionSuggestion     ← '@' → MentionMenu   (portal, Floating UI)
    │   └── SlashSuggestion       ← '/' → CommandMenu   (portal, Floating UI)
    ├── ComposerAttachments       ← attachedFiles state
    ├── ComposerBanners           ← reply / thread / queue / staged command
    └── ComposerToolbar           ← agent · model · voice · send
```

`Composer` holds: `attachedFiles`, `stagedCommand`, `isDragOver`. It does **not**
hold text. `ComposerToolbar` receives only stable props, so it re-renders when
the agent or model changes and at no other time.

Send reads the document imperatively from a ref
(`editorRef.current.getMarkdown()`), the same way the current code reads
selections at send-time in `composer-chat-input.tsx:168-178`.

The one thing the toolbar needs from the text is "is the send button enabled".
That is a boolean, not the text. The editor pushes it through a narrow
`onEmptyChange(isEmpty: boolean)` callback that fires only on the false↔true
transition — so it fires once when you type the first character, once when you
delete the last, and never in between.

### 4.2 Editor: ProseMirror via Tiptap

**Decision: ProseMirror, using Tiptap as the extension API. Confirmed by Jay,
2026-08-09.**

#### 4.2.0 Tiptap and ProseMirror are one stack, not two options

This needs stating plainly because the two names invite the reading that they
compete. They do not. `@tiptap/pm@3.27.1` declares **exactly 13 dependencies,
every one of them `prosemirror-*`**:

```
prosemirror-model      prosemirror-state       prosemirror-view
prosemirror-transform  prosemirror-history     prosemirror-keymap
prosemirror-inputrules prosemirror-commands    prosemirror-schema-list
prosemirror-dropcursor prosemirror-gapcursor   prosemirror-tables
prosemirror-changeset
```

Tiptap is a declarative extension API over ProseMirror. Writing Tiptap *is*
running ProseMirror: `editor.view` is a `prosemirror-view` `EditorView`,
`editor.state` is a `prosemirror-state` `EditorState`, and raw PM plugins can be
registered directly. Nothing is foreclosed by taking the ergonomic layer. This
is the same combination Claude.ai and Linear run.

**CodeMirror is not part of this design and never was.** It exists in this repo
only at `components/file-editors/code-editor.tsx` and
`components/file-editors/codemirror-diagnostics.ts`, for editing file contents.
It is unrelated to the composer.

Lexical is not installed in this repo at all.

#### 4.2.1 Licensing — MIT, no paid tier involved

Verified against the installed tree and the public registry on 2026-08-09, not
taken on reputation:

| Package set | Count | Licence |
|---|---|---|
| `@tiptap/*` installed in `apps/web` | 40 | **MIT** (every one) |
| `prosemirror-*` installed transitively | 13 | **MIT** (every one) |
| `@tiptap/suggestion@3.0.x` — to add | 1 | **MIT** |
| `@tiptap/extension-mention@3.0.x` — to add | 1 | **MIT** |

Both additions come from the same public repository as the core,
`github.com/ueberdosis/tiptap`.

What *is* commercial in the Tiptap ecosystem: **Tiptap Cloud** (hosted
collaboration servers, document storage, AI Cloud) and a set of **Pro
extensions** distributed through a private registry token — comments, version
history, AI generation, docx import/export.

**None of those appear in this design.** No Tiptap account, no API key, no
registry token, and no network call to any Tiptap service at runtime or build
time. Everything ships from the public npm registry under MIT.

Corroborating signal: `@tiptap/extension-mathematics@3.27.1` is installed here
under MIT, showing that v3 moved previously-Pro extensions into the open-source
core rather than the reverse.

#### 4.2.2 Extension list

Already on disk — nothing to evaluate on trust:

```
@tiptap/core@3.27.1  @tiptap/react@3.27.1  @tiptap/pm@3.27.1
prosemirror-{state,view,model,transform,history,keymap,inputrules,commands,...} × 13
```

To add: `@tiptap/suggestion` (drives both `@` and `/` from one code path).
Deliberately **not** `@tiptap/starter-kit` — it pulls tables, math and images we
do not want in a chat input. The extension list is explicit:

```
Document, Paragraph, Text, HardBreak, UndoRedo,
Placeholder,
Bold, Italic, Code, Strike, Link,
CodeBlock, BulletList, OrderedList, ListItem, Blockquote,
Mention (custom, §4.3), SlashCommand (custom, §5.2)
```

**Two corrections to this list, both made during T3 (2026-08-09):**

**`History` does not exist in TipTap 3** — it was renamed `UndoRedo` and lives in
`@tiptap/extensions`. Verified against the installed `@tiptap/extensions@3.27.1`
type declarations: `grep History` returns zero hits.

**`Typography` is removed, deliberately.** The first draft of this spec included
it. Its installed default rule set is `emDash, ellipsis, openDoubleQuote,
closeDoubleQuote, openSingleQuote, closeSingleQuote, leftArrow, rightArrow,
notEqual, copyright, trademark, registeredTrademark, oneHalf, plusMinus, laquo,
raquo, multiplication, superscript` — so **as the user types**, `a != b` becomes
`a ≠ b`, `-->` becomes `-→`, and `"foo"` gets curly quotes.

That is the same content-corruption class §4.2.3 fixes on the `setContent` path,
left live on the input path. This composer is where people type shell operators,
code fragments and file globs, and silently rewriting them is worse than
unhelpful. Do not add it back.

#### 4.2.3 `setContent` never receives a bare string

`@tiptap/core`'s `createNodeFromContent` has no plain-text mode: every branch
ends in `elementFromString(content)`, which is unconditionally
`new window.DOMParser().parseFromString(...)`. With `Bold`/`Italic`/`Code` in the
schema, prefilling `a<b>c` loses `<b>` to a bold mark, and `&amp;` collapses to
`&`.

Prefill carries **failed-send recovery text** — real user content that must
survive a round trip. So the editor converts plain text to ProseMirror JSON
before calling `setContent`, and never hands TipTap a bare string.

#### 4.2.4 Dependency pinning

`@tiptap/suggestion` is the one genuinely new package this branch adds — it is
pinned to `3.27.1`. (`@tiptap/extension-mention` was evaluated but has zero
imports in `src/`; the mention node is hand-built in
`composer/editor/mention-node.ts` instead, so that declaration was dropped, not
added.) `@tiptap/suggestion@3.27.1` declares **exact** peer dependencies —
`@tiptap/core: 3.27.1` and `@tiptap/pm: 3.27.1` — so both are pinned to
`3.27.1` too, not left on `^3.14.0`/`^3.3.0`. A caret range on either would
resolve past `3.27.1` on the next `pnpm update` and reproduce the same
unmet-exact-peer condition, silenced only by `legacy-peer-deps=true` in
`.npmrc`.

Four further packages — `@tiptap/extension-bold`, `-italic`, `-code` and
`@tiptap/extensions` — are declared explicitly. This repo uses
`nodeLinker: isolated` with empty `hoistPattern`, so transitive packages are not
resolvable from app source even when present. These four cost nothing on their
own: all four were already in the lockfile as `starter-kit` transitives.

The editor module is `dynamic(() => import(...), { ssr: false })` so ProseMirror
stays out of the first paint. **Superseded by measurement (see §6):** this
section originally estimated ~85–100 KB gz added to the composer chunk. Two
real `next build` runs measured **+136.0 KB gz** with the full markdown
extension set. §6 records the correction and the open trade-off; this
estimate should not be treated as current.

### 4.3 Mention node

```ts
{
  name: 'mention',
  group: 'inline',
  inline: true,
  atom: true,          // ← indivisible: one backspace, no caret inside
  selectable: true,
  attrs: { kind: 'file' | 'agent' | 'session', label: string, value: string },
}
```

Rendered as a badge using existing tokens — `bg-muted text-foreground rounded-md
px-1 py-0.5 text-[0.9em] font-medium`, with the kind's icon inline. This deletes
`TrackedMention[]`, `highlightSegments`, the mirror overlay, the transparent-text
trick, and the substring pruning in one move: the document holds the mentions,
so they cannot drift out of sync with the text.

### 4.4 What replaces the rotating placeholder

A single static placeholder via `@tiptap/extension-placeholder`, supplied by the
caller (`placeholder` prop, default `Ask anything…`). No interval, no
`AnimatePresence`, no re-render at rest. The keyboard hints those 12 strings were
teaching move into the `/` palette's empty state, where they are discoverable on
demand instead of rotating past.

---

## 5. Feature design

### 5.1 `@` mention menu

Sections, in order: **Agents**, **Sessions**, **Files**. Each row is icon +
primary label + dimmed secondary (path for files, relative time + changed-file
count for sessions). Keyboard: `↑`/`↓` move, `Enter`/`Tab` accept, `Esc`
dismiss. Selection index is derived, not stored in an effect.

Trigger rule unchanged in spirit — `@` at start of input or preceded by
whitespace — but implemented as `@tiptap/suggestion`'s `allowedPrefixes` rather
than the backwards character walk at `:1011-1032`.

**Caching (§ replaces effect 7).** File search moves to TanStack Query:

```ts
useQuery({
  queryKey: qk.workspaceFiles(sessionId, query),
  queryFn: () => searchWorkspaceFiles(query),
  enabled: isMentionOpen,
  staleTime: 30_000,
  gcTime: 5 * 60_000,
  placeholderData: keepPreviousData,   // ← replaces fileResultsCache
})
```

- `placeholderData: keepPreviousData` gives the "never flicker empty while
  narrowing" behaviour the `Set` was built for, without the `Set`.
- Query dedup + `seqRef` are both handled by the query key — the manual
  sequence counter goes.
- The cache is process-wide, so a second composer in another tab reuses it.
- Debounce moves to a `useDebouncedValue(query, 150)` on the key.
- Agents (`useRuntimeAgents`) and commands (`useRuntimeCommands`) already use
  TanStack Query with `staleTime: Infinity`. **Change commands and agents to
  revalidate on mention-menu open** so a newly created skill or agent appears
  without a reload — this is the "latest updated skills and files whenever we
  type @" requirement.

### 5.2 `/` command palette

Two sections:

- **Commands** — the real OpenCode commands from `useRuntimeCommands()`
  (`packages/sdk/src/react/use-opencode-sessions/commands.ts`). Unchanged
  execution path: selecting one stages it, the next Enter runs it with the typed
  text as args, exactly as `handleSelectCommand` does today.
- **Actions** — composer operations, executed locally, never sent to the agent:
  `Switch model`, `Switch agent`, `Set reasoning effort`, `Attach file`,
  `Start voice input`, `Set scope`. Each opens the control it names.

Rows are cards: icon tile, name, one-line description, and a right-aligned
keyboard hint where one exists. Fires at any caret position, not only offset 0.

Actions are a fixed local array — no new fetch, no new store.

### 5.3 Toolbar

```
┌────────────────────────────────────────────┐
│  Ask anything…                             │
├────────────────────────────────────────────┤
│  ⊕   Coordinator ▾   Opus 5 ▾   ▓░ 🎙 ( ↑ ) │
└────────────────────────────────────────────┘
```

Variant and reasoning effort move **inside** the model popover, below the model
list and above the "set as default" footer. Rationale: all three describe the
same thing — how this model runs. Agent and model both keep showing their value
at rest, which is the property whose loss killed the previous `…` overflow
attempt (`composer-toolbar.tsx:28-35`).

`ReasoningEffortSelector` stays capability-gated: it renders inside the popover
only when the selected model exposes the knob, same predicate as today.

**Mobile (< 640 px).** The row keeps `[attach] [agent] [model]` on the left and
`[voice] [send]` on the right; `TokenProgress` hides below `sm`. Agent and model
triggers get `max-w-[7rem] truncate`. Nothing wraps, nothing horizontally
scrolls. Touch targets are 40 px on coarse pointers via
`@media (pointer: coarse)`.

### 5.4 Send serialization

**Corrected 2026-08-09 after reading the real parsers. The first draft of this
section was wrong and is preserved below as a warning.**

The composer emits two things, and they serve different audiences:

| Output | Audience | Content |
|---|---|---|
| `text` | the human, in the transcript | markdown, with `@label` inline where a mention sat |
| `mentions: TrackedMention[]` | the machine | `{ kind, label, value? }` per mention |

**The `@label` in `text` is never parsed.** It exists so the sent message reads
naturally. The structured contract is the `mentions` array, and the handoff runs:

```
composer  ──{ text, mentions }──▶  session-chat.tsx handleSend  (:2760, :2815, :2919)
                                          │
                                          ▼  lib/project-preamble.ts:52-60
                              <file_ref path="…" name="…" />
                              <agent_ref name="…" />
                              <session_ref id="…" title="…" />
                                          │
                                          ▼  on render
              parseFileMentionReferences / parseAgentMentionReferences /
              parseSessionReferences   (message-parsing.tsx:111, :130, :43)
```

Those three parsers match **XML tags only** — `/<file_ref\b([\s\S]*?)\/>/g` and
friends. They have never matched an `@` token, and feeding them raw `text`
expecting `@label` to be recognised would silently drop every mention.

> **What the first draft got wrong.** It listed `@path/to/file.ts` as
> serializing "to" `parseFileMentionReferences`, collapsing the human-readable
> rendering and the machine contract into one column. Any task that wired
> `text` into those parsers on that basis would have produced a message where
> the agent received no file references at all — and nothing would have thrown.

Serialization rules by kind, unchanged in substance:

| Kind | `text` gets | `mentions[]` entry |
|---|---|---|
| `file` | `@path/to/file.ts` | `{ kind: 'file', label: path }` |
| `agent` | `@agent-name` | `{ kind: 'agent', label: name }` |
| `session` | `@Session Title` | `{ kind: 'session', label: title, value: sessionId }` |

`onSend(text, files, mentions)` keeps its exact current signature, and
`TrackedMention[]` is derived from the document at send-time rather than
maintained alongside it. **No consumer changes** — the blast radius stays inside
the composer.

### 5.5 Attachments

Adopt the tile treatment already shipped in `turn/user-message.tsx` so the
composer preview and the sent message are visually identical.

**Corrected 2026-08-09 — the first draft of this section was wrong twice.**

#### There are TWO shapes, not one

| Attachment | Class | Source |
|---|---|---|
| image, and the `+N` overflow tile | `size-20` — an 80×80 square | `user-message.tsx:568`, `:585` |
| **every non-image file** | `h-20 min-w-40` — 80 px tall, **min 160 px wide** | `user-message.tsx:603` |

The original draft said "one square tile per attachment". Applying the square to
everything makes a PDF a square while composing and a rectangle once sent —
the exact drift this section exists to prevent, hitting every non-image
attachment.

Both shapes live in `session/attachment-tile.tsx` and are imported by
`turn/user-message.tsx` and `composer/attachment-tiles.tsx`. **They are shared,
not copied.** The original draft said to copy the constants "so the two cannot
drift"; copying is precisely what makes them drift, because nothing then forces
a change in one to reach the other.

#### The hover/press feel is conditional

`TILE_INTERACTIVE` (`hover:bg-muted/50 cursor-pointer transition-colors
active:scale-[0.97]`) is applied by the sent message **only when the tile can
actually be opened** — `canOpen && TILE_INTERACTIVE` (`user-message.tsx:604`).

The composer's tiles have no click action, so they do not get `cursor-pointer`
or the press-scale. An affordance that promises a response it cannot deliver is
worse than a cosmetic mismatch: it teaches users that press cues in this product
are unreliable. Visual parity means the tile *looks* the same at rest, not that
it mimics interaction semantics it does not have.

*Tracked follow-up, deliberately out of scope:* letting a composer tile open a
pre-send preview. The primitives already exist (`af.localUrl`,
`PreviewImage`/`PreviewImageTrigger`), and it would make the affordance honest
rather than removed.

#### The rest

- Wrapping flex row, replacing the current 120×112 card grid
  (`attachment-preview.tsx:146-190`).
- Remove affordance is a corner `×` — revealed on hover, always visible on touch
  via `[@media(pointer:coarse)]:opacity-100`, keyboard-reachable via
  `focus-visible:opacity-100`.
- **The `<li>` must not carry `relative`.** `display: contents` suppresses the
  element's box, so `position: relative` on it is inert and an absolutely
  positioned child escapes to some other ancestor. `user-message.tsx` uses plain
  `className="contents"` and puts `relative` on the real tile box instead
  (`:559`, `:581`, `:593` vs `:603`).
- Kept from the current implementation: HEIC→JPEG conversion (browsers cannot
  render HEIC natively) and the text/code preview reader. The preview backdrop
  must genuinely paint *behind* the icon and filename — in one stacking context,
  in-flow non-positioned content paints before positioned content regardless of
  source order, so an `absolute inset-0` sibling lands on top by default.

Keep from the current implementation: HEIC→JPEG conversion, text/code preview
thumbnails, and the object-URL lifecycle (revoke on success, retain on failure
so a failed send stays retryable).

### 5.6 Colour, border, shadow, accessibility

- Surface `bg-card`, `border-border`, `rounded-xl`, resting `shadow-none`.
  Focus-within raises to `shadow-sm` and `border-foreground/20` — one state
  change, no glow.
- Focus ring is the token `ring-ring` at 2 px with a 2 px offset, on the card,
  not the inner editor.
- Every icon-only control keeps an `aria-label`; the popovers use
  `role="listbox"` + `aria-activedescendant` (the current ones use neither).
- The editor is `role="textbox" aria-multiline="true"` with an `aria-label`.
- Mention badges carry `aria-label="file mention: <path>"` so a screen reader
  does not read a bare path.
- Contrast: all text ≥ 4.5:1, verified against both themes.
- `prefers-reduced-motion` disables the menu enter/exit transitions.

---

## 6. Performance budget

| Metric | Now | Target | How measured |
|---|---|---|---|
| React commits per keystroke | 1 full subtree | **0** | React DevTools Profiler, 20-char burst |
| Commits per 60 s idle, empty composer | 10 | **0** | Profiler, 60 s recording |
| `ModelSelector` renders per keystroke | 1 | **0** | Profiler component chart |
| Composer chunk (gz) | baseline | baseline + ≤ 100 KB | `pnpm build` + bundle report, recorded both sides |
| Mention menu open → first paint | — | < 100 ms warm cache | Performance marks |

**Correction — the 100 KB ceiling and its cut rule did not survive contact
with a real measurement, and the branch says so rather than quietly
overriding it.** The row above originally read "the bundle row is a budget,
not a prediction: if the measured delta exceeds 100 KB gz, the extension list
gets cut before the PR opens." That rule was written as an estimate before any
of this code existed, with no real `next build` behind it.

Two real `next build` runs (verification doc §7.1) measured the composer
chunk at **+136.0 KB gz** with the full markdown extension set spec §2 Goal 4
requires — 36 KB over the ceiling. The cut rule was then actually attempted:
`Blockquote`/`Bold`/`Italic`/`Strike`/`Code`/`CodeBlock`/`Link`/`BulletList`/
`OrderedList`/`ListItem` were removed from `extensions.ts` and the chunk
re-measured at **+102.9 KB gz** — still ~2.9 KB over the ceiling even with
markdown support gone entirely. That cut was **reverted**: every one of those
ten extensions is load-bearing for markdown input rules and send-time
serialization, an explicit user requirement ("we need to make this essential
input markdown-friendly. Markdown should be supported properly"), not
something the compat matrix happened to omit.

**The cut rule in this section is explicitly overridden for this branch.**
The 100 KB ceiling was never achievable with ProseMirror plus the `@`/`/` menu
system and markdown support at all — the maximal cut only reached 102.9 KB,
still over budget. Closing the remaining ~36–37 KB gap means either raising
the budget or dropping the markdown requirement. **That trade-off is open,
left for the user to decide — not resolved by this task.** See verification
doc §7.2 for the full measurement, the reverted cut commit, and the
byte-for-byte restore proof.

---

## 7. Compatibility matrix — behaviour that must not regress

This is the real risk surface of a rewrite. Each row needs a test or a scripted
manual check before the PR merges.

| # | Behaviour | Source |
|---|---|---|
| 1 | Prefill: starter prompts, and failed-send recovery in `merge` mode | `:349-381`, `composer-draft-recovery.ts` |
| 2 | Draft saved and restored around a structured question | `:383-394` |
| 3 | Composer locked while a connector approval is pending | `lockForApproval` |
| 4 | Submitting while busy enqueues instead of sending | `message-queue-boundary.ts` |
| 5 | Failed queued messages render below the queue with retry | `queued-messages.tsx` |
| 6 | Drag-and-drop file attach, with nested-enter depth counting | `:526-568` |
| 7 | Paste-to-attach images and files | `clipboard-files.ts` |
| 8 | Staged command badge, args entry, Esc to cancel | `:1191-1218` |
| 9 | `Tab` cycles agents when no menu is open | `:982-988` |
| 10 | `Enter` sends, `Shift+Enter` newline | `:990-993` |
| 11 | Typing anywhere on the page focuses the composer | `:398-430` |
| 12 | `focus-session-textarea` event focuses the visible composer | `:451-467` |
| 13 | autoFocus when revealed inside a hidden tab | `:475-499` |
| 14 | Triple-`Esc` stop, with the ×2/×1 hint | `send-stop-control.tsx:66-79` |
| 15 | Sub-session "back to parent" indicator | `threadContext` |
| 16 | Reply-to banner and clear | `:1147-1166` |
| 17 | Model connection gate bar and hard-disabled send | `model-connection-gate.tsx` |
| 18 | Token progress and context click-through | `token-progress.tsx` |
| 19 | Session scope toolbar, incl. new-session draft commit | `scope/session-scope-toolbar.tsx` |
| 20 | `clearOnSend={false}` on project-home does not clear or revoke URLs | `composer-reset.ts` |
| 21 | Voice transcription appends to existing text | `:1050-1052` |
| 22 | Agent selector locked inside a meta-agent session | `agentSelectorLocked` |
| 23 | Sessions match on the files they changed (`summary.diffs[].file`), so `@auth.ts` surfaces past sessions that touched it | `:678-682` |
| 24 | The `@` menu lists hidden agents and subagents — it filters raw `agents` by name only; the `hidden`/`subagent`-filtered `primaryAgents` feeds Tab-cycling and the toolbar, never the menu | `:665` (vs `:312-314`, `:982`, `:1334`) |

Rows 23 and 24 were added in Task 14. Both are user-visible behaviours this
section originally omitted; both were identified in Task 6 and are now pinned by
tests in `composer/menus/menu-items.test.ts`.

Verification results for all 24 rows:
`docs/superpowers/plans/2026-08-09-enhance-chat-input-verification.md`.

---

## 8. Migration

Build `v2` alongside, swap all call sites, replace the old implementation **in
the same PR**. No feature flag, no two composers in the tree.

### 8.1 Render sites — 3, verified

| File | Line | Renders |
|---|---|---|
| `features/session/session-chat.tsx` | 3937 | `<SessionChatInput>` directly |
| `features/session/instant-session-shell.tsx` | 187 | `<ComposerChatInput>` |
| `features/workspace/project-layout/project-home.tsx` | 204 | `<ComposerChatInput>` |

`composer-chat-input.tsx:181` is the selector-wiring wrapper, not a fourth
consumer. Because it keeps its exact public props, the two `ComposerChatInput`
sites need **no edit at all** — only `session-chat.tsx` is touched.

### 8.2 `session-chat-input.tsx` becomes a re-export barrel — it is not deleted

**Correction to the original plan.** The module has **13 external importers**,
not the two assumed:

| Imported symbol | Importers |
|---|---|
| `flattenModels` | `plan-step.tsx`, `schedule-view.tsx`, `command-palette.tsx`, `agent-detail-aside.tsx`, `agent-editor-basics-fields.tsx`, `channels-view.tsx` |
| `AttachedFile` | `session-composer-handoff-store.ts`, `app/(app)/projects/[id]/page.tsx`, `uploaded-file-refs.ts`, `instant-session-shell.tsx`, `project-home.tsx` |
| `AgentSelector` | `schedule-view.tsx`, `channels-view.tsx` |
| `FlatModel` | `model-rows.ts` |
| `TrackedMention` | `instant-session-shell.tsx` |

Deleting the file would mean rewriting 13 unrelated import statements across
onboarding, the command palette, schedules, channels and the agent editor —
noise that has nothing to do with the composer and would make the PR
unreviewable.

So the file is **emptied of implementation and kept as a pure re-export
barrel**:

```ts
// session-chat-input.tsx — public module boundary, no logic.
export { Composer as SessionChatInput } from './composer/composer';
export type { SessionChatInputProps } from './composer/composer';
export { AgentSelector } from './composer/agent-selector';
export { flattenModels, type FlatModel } from './model-flatten';
export type { AttachedFile, MentionItem, TrackedMention } from './composer/types';
export type { ProviderListResponse } from '@kortix/sdk/react';
```

1,383 lines → ~8. That is the deletion, expressed in a way that touches three
files instead of sixteen. A barrel is a module boundary, not dead code.

---

## 9. Testing

- **Unit (`bun:test`)** — markdown serialization round-trip; mention
  serialization per kind; slash-action registry; the derived selection-index
  clamp; `isEmpty` transition firing exactly on the boundary.
- **Existing suites must stay green untouched** — `composer-reset.test.ts`,
  `composer-draft-recovery.test.ts`, `message-queue-boundary.test.ts`,
  `queued-messages-logic.test.ts`, `model-availability.test.ts`,
  `model-flatten.test.ts`. If a rewrite needs one of these changed, that is a
  signal the contract moved and needs saying out loud, not editing quietly.
- **Component** — mention insert/delete-as-one-unit; `/` at non-zero offset;
  queue-instead-of-send while busy.
- **Gates** — `npx tsc --noEmit` in `apps/web`, `npx eslint` on changed files,
  both clean of new errors.

Per the `no-browser-verification` standing instruction, verification is by code
review plus `bun test` / `eslint` / `tsc`, not by driving a browser.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Mobile IME (Android/Korean/Japanese) composition breaks in contentEditable | ProseMirror has first-class composition handling; add explicit `compositionstart`/`end` tests before merge |
| Bundle exceeds the 100 KB budget | Extension list is explicit and cuttable; measured before PR opens, not after |
| A §7 behaviour is silently dropped | The matrix is the PR checklist; each row cited to its current source |
| Serialization drift changes what the agent receives | §5.4 keeps the exact wire format; round-trip unit tests pin it |
| Undo/redo semantics change | ProseMirror `History` replaces native textarea undo; verify Cmd+Z across a mention insert |

---

## 11. Open questions

Both original questions are now **answered with evidence** (T7, 2026-08-09).

### 11.1 Do skills surface through `command.list()`? — YES

`@opencode-ai/sdk@1.17.11`, `dist/v2/gen/types.gen.d.ts:1974`:

```ts
export type Command = {          // :1969
  …
  source?: "command" | "mcp" | "skill";
}
```

Neither `useOpenCodeCommands` (`packages/sdk/src/react/use-opencode-sessions/commands.ts:13-29`)
nor the current popover filter (`slash-command-popover.tsx:26-32`) excludes by
`source`. So skill-backed commands **already flow through `command.list()`** and
already render in the Commands section.

**Consequence:** showing skills as their own group in `/` needs no new data
source, no new fetch, and no new store — only a `groupBy` on a field already on
the wire. §5.2 is updated to split the Commands section by `source`.

*Not verified:* whether a live OpenCode server actually populates
`source: "skill"` rows today. That needs a running session, which the
no-browser verification standard excludes. The grouping must therefore degrade
cleanly to a single "Commands" group when every row has the same source.

### 11.2 Does `/set-scope` have a control to open? — IT EXISTS, BUT CANNOT BE OPENED

The control is real and already in the composer toolbar. Chain verified:

```
composer-chat-input.tsx:144-165  →  session-chat-input.tsx:1350 (toolbarSlot)
  →  session-scope-toolbar.tsx:246-258  →  session-scope-control.tsx:445-472
```

**But `session-scope-control.tsx:450` renders a bare `<Popover>`** — no `open`,
no `onOpenChange`. It is uncontrolled, so nothing external can open it
programmatically. A `/set-scope` action wired today would be a menu row that
does nothing, which is worse than omitting it.

**Resolution:** §5.2's `set-scope` action stays, and §5.3's file list gains
`session-scope-control.tsx` — the Popover becomes controlled. This is a
deliberate scope expansion of one file, recorded here so it does not arrive as a
surprise mid-task.
