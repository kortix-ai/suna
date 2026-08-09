# Enhance Chat Input — verification

**Task:** 14 (verification) of the composer rebuild
**Branch:** `message-input`
**Base:** `1fd281f897` (last commit before the rebuild)
**Head at verification:** `8ed4c9c4d6` + this task's commit
**Spec:** `docs/superpowers/specs/2026-08-09-enhance-chat-input-design.md`
**Ledger:** `.superpowers/sdd/2026-08-09-enhance-chat-input/progress.md`

The old implementation is gone from the tree. Every "old" citation below is read
from `git show 1fd281f897:apps/web/src/features/session/session-chat-input.tsx`
(1,382 lines; the spec's line numbers match it).

---

## 0. Summary

**Four of the 24 rows regressed. All four are now fixed, and all four are
PROVEN by mutation.** The most consequential was row 10: `Shift+Enter` produced
a `hardBreak` node that the send-path serializer turned into the empty string,
so **every multi-line message reached the agent with its line breaks deleted and
the surrounding words glued together** (`line one` + Shift+Enter + `line two`
was sent as `line oneline two`). It hid because the existing test asserted
`editor.getText()`, which walks the document by a different route and *does*
return the newline — the tested path and the shipped path disagreed.

Every row carries exactly one verdict. The three below partition all 24:

| Verdict | Count | Rows |
|---|---|---|
| PROVEN | **6** | 1, 10, 18, 21, 23, 24 |
| CODE-VERIFIED | **17** | 2, 3, 4, 5, 6, 7, 8, 9, 11, 13, 14, 15, 16, 17, 19, 20, 22 |
| UNVERIFIABLE HERE | **1** | 12 |
| **Total** | **24** | |

"Regressed, then fixed" is **not** a fourth verdict — it is a property of four
rows that already appear above. Those four are **rows 1, 10, 18 and 21**, a
subset of the six PROVEN: each was found broken, fixed in this task, and bound
by a test whose binding was confirmed by reverting the fix and watching the
named tests fail.

All four regressions restore documented pre-rewrite behaviour. None of them is a
new product direction.

### Gates

| Gate | Result | Baseline |
|---|---|---|
| `bun test src/features/session` | **1394 pass, 0 fail** (121 files) | 1360 pass — +34 added here, all additive |
| `npx tsc --noEmit` | **15 errors**, none in `composer/` | 15 pre-existing (2 `src/app/`, 6 `preview-fit.test.tsx`, 7 `easy-panel-logic.test.ts`) |
| `npx eslint src/features/session/composer/` | **3 warnings, 0 errors** | 3 warnings, 0 errors |
| `git diff -- packages/sdk` | **empty** | required zero-diff |
| Protected suites diff | **empty** (§5) | required zero-diff |
| Test lines removed | **0** | no test weakened, skipped or deleted |

---

## 1. Method, and what each verdict means

- **PROVEN** — a test exercises the row's user-visible behaviour. Where marked
  "by mutation", the implementation was broken on purpose, the named test was
  watched to fail, and the change was reverted.
- **CODE-VERIFIED** — no test covers the row end-to-end, but both
  implementations were read and they agree, cited `file:line` on each side.
- **UNVERIFIABLE HERE** — genuinely needs a browser. The precise interaction
  that would settle it is stated.
- **REGRESSED** — the behaviour is gone or changed.

**A tested pure helper is not a proven row.** Many rows call a pure function
that has its own passing suite (`resolveComposerResetOnSend`,
`shouldQueueInsteadOfSend`, `resolveEditorPlaceholder`,
`planFailedSendRecovery`). Those suites prove the *helper*. They do not prove
that `composer.tsx` still calls it, with the right arguments, at the right
moment. This was demonstrated during Task 13: a reviewer replaced the entire
failed-send recovery block with `if (false && …)` and the suite stayed at
1340/1340 pass. Rows in that situation are recorded as CODE-VERIFIED with the
helper's test named, never as PROVEN.

No browser and no dev stack were used — a standing instruction for this repo.

---

## 2. Compatibility matrix

Spec §7 ships 22 rows. Rows **23** and **24** are added here; both are
user-visible behaviours the spec omitted, identified during Task 6.

| # | Behaviour | Verdict |
|---|---|---|
| 1 | Prefill: starter prompts, failed-send recovery in `merge` mode | **REGRESSED — fixed here**, now **PROVEN** |
| 2 | Draft saved/restored around a structured question | CODE-VERIFIED |
| 3 | Composer locked while a connector approval is pending | CODE-VERIFIED |
| 4 | Submitting while busy enqueues instead of sending | CODE-VERIFIED |
| 5 | Failed queued messages render below the queue with retry | CODE-VERIFIED |
| 6 | Drag-and-drop file attach, nested-enter depth counting | CODE-VERIFIED |
| 7 | Paste-to-attach images and files | CODE-VERIFIED |
| 8 | Staged command badge, args entry, Esc to cancel | CODE-VERIFIED |
| 9 | `Tab` cycles agents when no menu is open | CODE-VERIFIED |
| 10 | `Enter` sends, `Shift+Enter` newline | **REGRESSED — fixed here**, now **PROVEN** |
| 11 | Typing anywhere on the page focuses the composer | CODE-VERIFIED |
| 12 | `focus-session-textarea` focuses the visible composer | UNVERIFIABLE HERE |
| 13 | autoFocus when revealed inside a hidden tab | CODE-VERIFIED |
| 14 | Triple-`Esc` stop, with the ×2/×1 hint | CODE-VERIFIED |
| 15 | Sub-session "back to parent" indicator | CODE-VERIFIED |
| 16 | Reply-to banner and clear | CODE-VERIFIED |
| 17 | Model connection gate bar and hard-disabled send | CODE-VERIFIED |
| 18 | Token progress and context click-through | **REGRESSED — fixed here**, now **PROVEN** |
| 19 | Session scope toolbar, incl. new-session draft commit | CODE-VERIFIED |
| 20 | `clearOnSend={false}` does not clear or revoke URLs | CODE-VERIFIED |
| 21 | Voice transcription appends to existing text | **REGRESSED — fixed here**, now **PROVEN** |
| 22 | Agent selector locked inside a meta-agent session | CODE-VERIFIED |
| 23 | Sessions match on the files they changed | **PROVEN** (mutation) |
| 24 | The `@` menu lists hidden agents and subagents | **PROVEN** (mutation) |

---

### Row 1 — Prefill: starter prompts, and failed-send recovery in `merge` mode

**Verdict: REGRESSED — FIXED IN THIS TASK. Now PROVEN by mutation.**

(`replace` mode was always correct; `merge` mode was not.)

- **Old** `session-chat-input.tsx:349-381` —
  `setText(current => prefillMode === 'merge' ? mergeFailedSubmissionText(current, prefillText) : prefillText)`.
  `mergeFailedSubmissionText(current, submitted)` returns
  `` `${submitted}\n\n${current}` `` (`composer-draft-recovery.ts:5-9`) — the
  **prefill first**, the user's in-flight draft after — and dedupes
  (`if (!submitted || current === submitted) return current`).
- **New** `composer/composer.tsx:801-823` —
  `editorRef.current?.setContent(prefillText, prefillMode === 'merge' ? 'merge' : 'replace')`.
  `setContent`'s merge branch (`composer/editor/composer-editor.tsx:485-489`) is
  `editor.commands.insertContent([{ type: 'paragraph' }, ...paragraphs])`, which
  inserts **at the current selection** and appends **after** existing content,
  with no dedupe.

**Evidence — measured, not inferred.** A throwaway probe drove a real headless
`@tiptap/core` editor with the production extension set and the verbatim
`setContent` merge branch, and read the result through the production
`serializeDocument`:

```
ROW1 ordering  OLD="recovered\n\nmy draft"   NEW="my draft\n\nrecovered"
ROW1 dedupe    OLD="same"                    NEW="same\n\nsame"
ROW1 emptytext OLD="my draft"  NEW="my draft"  | doc childCount 1 -> 3
```

Three distinct deltas:

1. **Ordering inverted.** The recovered draft used to land above what the user
   typed while the send was failing. It now lands below it.
2. **Dedupe gone.** Re-applying an identical prefill used to be a no-op; it now
   duplicates the text.
3. **Files-only prefill injects blank lines.** `shouldApplyPrefill` returns
   `true` for `prefillText: ''` when files are present (`composer-logic.ts:156`,
   asserted at `composer-logic.test.ts:79`). The serialized wire text is
   unchanged, but the document gains two empty paragraphs (`childCount 1 → 3`) —
   two blank lines the user sees and has to delete.

**Live callers of `mode: 'merge'`** (both reachable):
`session-chat.tsx:3946` (`failedStartDraft` — the failed-first-turn recovery,
and the one that can carry empty text plus files) and `session-chat.tsx:3949`
(`sessionPrefill` — the rewind / "Ask for changes" hand-off).
`session-chat.tsx:3384` builds the same `failedStartDraft` shape for
`chatPrefill`.

**Also:** `mergeFailedSubmissionText` and `mergeFailedSubmissionMentions` now
have **zero production consumers** (`grep` across `src/`, excluding their own
module, returns nothing). Their tests in the protected
`composer-draft-recovery.test.ts` still pass but no longer guard any shipped
path.

**What still works:** `replace` mode (starter prompts —
`project-home.tsx:223`; the rewind draft — `session-chat.tsx:3939`) is
equivalent. The *separate* in-composer failed-send recovery in `handleSubmit`'s
catch block is **not** affected — it uses `mergeFailedSubmissionDocument`
(`composer-draft-recovery.ts:47-60`), which keeps submitted-first ordering and
its own dedupe, and every branch is asserted in `composer-logic.test.ts:194-332`.

**The `editorReady` guard is PROVEN.** Deleting `if (!editorReady) return false;`
from `shouldApplyPrefill` kills 1 test in `composer-logic.test.ts` (21 pass / 1
fail); reverted clean. So the Task 12 Critical fix — a prefill arriving before
the lazy editor chunk resolves — is bound.

**Fix (this task).** `composer.tsx`'s prefill effect now routes `merge` mode
through `planPrefillMerge` (`composer-logic.ts`) instead of
`setContent(prefillText, 'merge')`. `planPrefillMerge` delegates to
`mergeFailedSubmissionDocument`, which already implements
`mergeFailedSubmissionText`'s exact three-branch contract — on documents rather
than strings, so mention atoms on either side survive, which the string version
could never have done in this editor. It returns `null` for "leave the document
alone", the same contract `planFailedSendRecovery.restoreDoc` uses, which
restores both no-op branches *and* preserves the user's caret by skipping the
write entirely.

`textToParagraphs`/`textToDocument` moved from `editor/composer-editor.tsx` into
`composer-logic.ts` so both files share one definition. That direction matters:
`composer-editor.tsx` is behind the `React.lazy` boundary, so importing a value
*from* it would have pulled TipTap and ProseMirror into the first-paint bundle.
`composer-logic.ts` imports `JSONContent` as a type only and stays runtime-free
of TipTap.

**Bound by 9 new tests.** Five in `composer-logic.test.ts` under
`describe('planPrefillMerge — merge-mode prefill restores the live semantics')`
cover prefill-first ordering, the identical-prefill dedupe, the files-only
no-op, the empty-composer case, and mentions carried through from both sides.
Four more in `composer-editor.test.ts` drive the whole path through a real
headless editor and assert the serialized result **equals
`mergeFailedSubmissionText(current, prefill)` itself** — pinning the restored
behaviour to the original implementation rather than to my reading of it — plus
the spelled-out string, the `childCount` guard for the files-only case, and the
structured `mentions` array after a merge.

**Mutation-verified, twice:**

| Mutation | Result |
|---|---|
| Swap the argument order so the prefill lands last again | **6 tests fail** |
| Replace `merged === currentDoc ? null : merged` with `merged` (drops dedupe and the empty-prefill no-op) | **4 tests fail** |

Both reverted; 70 pass across the two files.

**Still true after the fix:** `mergeFailedSubmissionText` and
`mergeFailedSubmissionMentions` remain without production consumers. The
document-level `mergeFailedSubmissionDocument` genuinely subsumes them — it is
now the single implementation behind both the failed-send catch block and
merge-mode prefill. `mergeFailedSubmissionText` is still *referenced* by the new
row-1 tests, deliberately, as the executable definition of the behaviour being
preserved. Deleting the two orphans is a reasonable follow-up, but it would
remove that oracle, so it is flagged rather than done.

---

### Row 2 — Draft saved and restored around a structured question

**Verdict: CODE-VERIFIED**

- **Old** `:383-394` — `savedTextBeforeQuestionRef.current = text; setText('')`
  on lock; `else if (saved) { setText(saved); saved = '' }` on unlock. Dep
  `[lockForQuestion]`.
- **New** `composer/composer.tsx:840-849` — `isEmpty()` decides whether to save,
  `getDocument()` snapshots, `clear()` empties; on unlock
  `setDocumentWithoutStealingFocus(…, 'replace')`. Same single dep.

Two deliberate improvements, both verified: the snapshot is now the ProseMirror
document, so mention atom nodes survive the round trip (the string round trip
flattened them to inert `@label` text and silently dropped the next send's
`<file_ref>` block); and the restore no longer steals focus
(`composer.tsx:295-307`), matching the old `setText`, which never moved focus.

**Open sub-case:** if `lockForQuestion` flips true before the lazy editor chunk
resolves, `editorRef.current` is `null` → nothing is saved *and* `clear()`
no-ops, so the draft stays visible under the question. The old code held `text`
in React state and always cleared. Unlike the prefill effect, this one does not
watch `editorElement`. Narrow (a question requires a completed server turn) but
real.

---

### Row 3 — Composer locked while a connector approval is pending

**Verdict: CODE-VERIFIED**

| Leg | Old | New |
|---|---|---|
| Submit guard | `:751-754` `toast.error('Approve or deny the pending action to continue.')` | `composer.tsx:904-907`, byte-identical |
| Send disabled | `:740` `submitDisabled = disabled \|\| modelUnavailable \|\| lockForApproval` | `composer.tsx:774`, identical |
| Input inert | `:1307` `disabled={disabled \|\| lockForApproval}` on the textarea | `composer.tsx:1202` `disabled={editorDisabled}` → `editable: !disabled` (`composer-editor.tsx:405`, `:459-461`) |
| Placeholder + amber | `:1232-1235` inline `text-amber-600 dark:text-amber-400` | `resolveEditorPlaceholder` (`composer-logic.ts:189`, same string) + `.composer-locked-approval` → `globals.css:2050,2053`, scoped to `p.is-editor-empty:first-child::before` |

Placeholder precedence has a helper test — `composer-logic.test.ts:128`
`'lockForApproval wins over lockForQuestion when staged command is not active'`.
That proves the helper; the call site (`composer.tsx:1042` → `:1201`) is
code-verified.

**Notes.** `useComposerFocus` is now disabled under `disabled || lockForApproval`
(`composer.tsx:756`) where the old global redirect checked `disabled` alone —
strictly tighter, and this task hoisted the condition so it can no longer drift
(§3, item 14). Unchanged in both: file attach and drag/drop gate on
`disabled || lockForQuestion`, **not** `lockForApproval`, so files can still be
attached during an approval lock. The amber colour is CSS-only and untested.

---

### Row 4 — Submitting while busy enqueues instead of sending

**Verdict: CODE-VERIFIED**

Old `:826-836` and new `composer.tsx:958-968` are the same call with the same
argument expressions, in the same position (after
`resolveComposerResetOnSend`, before `await onSend`), with the same early
`return`. `message-queue-boundary.ts` is byte-unchanged.

Its suite (`message-queue-boundary.test.ts`, protected and unmodified) covers
the **pure helper** — `'queues while the agent is running'`, `'queues behind
anything already waiting, even when the session reads idle'`, `'queues while a
claimed message is on the wire'`. No test exercises `handleSubmit`.

Only difference: `mentionsToSend` now comes from
`editorRef.current.getContent().mentions` (`composer.tsx:944`) instead of a
parallel `mentions` state array.

---

### Row 5 — Failed queued messages render below the queue with retry

**Verdict: CODE-VERIFIED**

Old `:1135-1146` and new `composer.tsx:1084-1095` pass identical props to
`QueuedMessages`, inside an identical wrapper condition, with the same
`EMPTY_QUEUE` fallback. `queued-messages.tsx` and `queued-messages-logic.ts` are
both byte-unchanged; the failed block still lives at `queued-messages.tsx:366-402`
(separate `<ul>` after the queue, `WarningIcon`, `lastError`, Retry, Dismiss).
Parent wiring at `session-chat.tsx:3954`/`:3961` is untouched.

`queued-messages-logic.test.ts` (protected, unmodified) covers
expand/summary/reorder/focus helpers, none of the failed-list rendering.

---

### Row 6 — Drag-and-drop file attach, with nested-enter depth counting

**Verdict: CODE-VERIFIED**

All four handlers are character-identical (old `:522-568` ↔ new
`composer.tsx:457-503`), including the depth counting
(`dragDepthRef.current += 1` / `Math.max(0, … - 1)` / reset to `0` on drop) and
including the detail that `handleDragLeave` deliberately omits the
`disabled || lockForQuestion` gate so the counter can never strand. Same
attachment point (`cardRef`), same overlay copy key.

**The one thing that genuinely changed — and it is safe.** The drop target is
now a ProseMirror `contenteditable`, not a `<textarea>`, so ProseMirror has its
own `drop` handler on `view.dom`. Read from the installed
`prosemirror-view@1.42.0/dist/index.cjs:3593-3625`: `handleDrop` calls
`event.preventDefault()` in two places and **never** `stopPropagation()`.
For a files-only drop `parseFromClipboard` yields no slice, so it returns at
`if (!slice) return;` without even preventing default. Either way the event
still reaches the card's React `onDrop`. `composer-editor.tsx` / `extensions.ts`
register no `handleDrop`, `handleDOMEvents` or drag handlers of their own.

Not covered by a test; `attachment-tiles.test.tsx` covers tile layout and
removal, not the drag path.

---

### Row 7 — Paste-to-attach images and files

**Verdict: CODE-VERIFIED**

The handler body is verbatim (old `:570-580` ↔ `composer.tsx:527-533`), moved
from the textarea's React `onPaste` to a **capture-phase** native listener on
`editorElement` (`composer.tsx:534`). Capture is what wins the ordering:
ProseMirror registers `editHandlers.paste` on `view.dom` in the bubble phase at
construction (`prosemirror-view/dist/index.cjs:3538`), and a paste's real target
is a descendant text node, so a capture listener on the ancestor runs first.
`extractClipboardFiles` is unchanged and has 7 tests in `clipboard-files.test.ts`
— the **pure helper** only.

**Open sub-cases:** `preventDefault()` does not stop ProseMirror's own paste
handler from running; for a files-only clipboard it finds nothing to insert and
falls into `capturePaste`, which focuses a hidden contenteditable and restores
focus ~50 ms later — a focus round-trip the textarea never had. Visible only in
a browser. Also, the new guard is `disabled || lockForQuestion`, whereas the old
`disabled` textarea received no paste event at all under `lockForApproval`.

---

### Row 8 — Staged command badge, args entry, Esc to cancel

**Verdict: CODE-VERIFIED**

Badge JSX is byte-identical (old `:1191-1218` ↔ `composer.tsx:1143-1170`); args
submit is the same (`:757-772` ↔ `composer.tsx:909-923`) with
`text.trim()` replaced by `(editorRef.current?.getContent().text ?? '').trim()`;
Escape moved from the textarea's `onKeyDown` first branch (`:922-929`) to a
native `keydown` listener (`composer.tsx:561-576`) with the same body.

The placeholder is PROVEN at the helper: `composer-logic.test.ts:117`
`'staged command wins over everything else'` asserts the exact string with
`lockForApproval` and `lockForQuestion` both true.

**Ordering note, outcome unchanged:** the suggestion plugin consumes Escape
first (`@tiptap/suggestion@3.27.1/dist/index.cjs:175-179`), but the composer's
listener does not check `defaultPrevented`, so the staged command is still
cancelled. **Improvement, not a regression:** `composer.tsx:1197-1198` passes
`EMPTY_COMMANDS`/`EMPTY_ACTIONS` while staged, so the `/` palette is fully
suppressed during args entry; the old code only disabled slash *detection*.

---

### Row 9 — `Tab` cycles agents when no menu is open

**Verdict: CODE-VERIFIED**

`primaryAgents` is the same expression on both sides (`:312-315` ↔
`composer.tsx:423-426`), and `cycleAgent` (`composer.tsx:553-559`) carries the
same three guards, including `agentSelectorLocked`.

The "no menu is open" gate moved from *position* to *`defaultPrevented`*. Old:
the Tab branch sat after the mention and slash branches, whose `return`s were
the gate. New: `if (e.key === 'Tab' && !e.defaultPrevented)`. That is sound —
the controllers return `false` when `nav.getRows().length === 0`
(`mention-controller.ts:103`, `slash-controller.ts`), the suggestion plugin
returns that boolean, and `prosemirror-view/dist/index.cjs:3017-3020` calls
`event.preventDefault()` only when a handler returned true. ProseMirror's
listener is registered at construction, the composer's later on the same node,
both bubble — so ProseMirror always runs first. The zero-rows case therefore
falls through to agent cycling, matching old `:932`'s `mentionItems.length > 0`
guard.

**New Tab consumer the textarea could not have:** `@tiptap/extension-list` binds
`Tab: sinkListItem`. Inside a list, Tab indents and cycling steps aside;
`sinkListItem` returns false on the first item, where Tab still cycles. Also,
`cycleAgent` does not check `disabled` — not reachable in practice, since a
`contenteditable="false"` node is not focusable, but the guard the textarea got
for free is gone from the code. No test covers Tab.

---

### Row 10 — `Enter` sends, `Shift+Enter` newline

**Verdict: REGRESSED — FIXED IN THIS TASK. Now PROVEN by mutation.**

**Enter-sends is PROVEN by mutation.** Changing
`if (event.key === 'Enter' && !event.shiftKey)` to
`if (event.key === 'Enter')` in `createSubmitOnEnterHandler`
(`composer-editor.tsx:177`) kills 1 test in `composer-editor.test.ts`
(29 pass / 1 fail); reverted clean. The four handler tests at `:214`, `:229`,
`:247`, `:262` bind Enter, disabled-Enter, Shift+Enter and other keys.

**Shift+Enter was broken on the send path.** `Shift+Enter` reaches
`@tiptap/extension-hard-break`'s keymap and inserts a `hardBreak` inline leaf.
`serializeDocument` — the **real** send path
(`composer-editor.tsx:481 getContent()` → `composer.tsx:939` → `onSend(text,…)`)
— serialized that leaf to the **empty string**:

```
HB childCount        = 1
HB getText()         = "line one\nline two"      <- what every existing test asserted
HB serializeDocument = "line oneline two"        <- what was actually sent
HB hardBreak spec.leafText = undefined
```

Root cause, `composer/editor/serialize.ts:89-91`: `doc.textBetween(0, size,
'\n', leafTextFn)`. Passing an explicit `leafText` **function** makes
ProseMirror use it for *every* inline leaf and ignore `node.type.spec.leafText`;
`hardBreak` has no `spec.leafText` of its own, so it fell to the `return ''`
default. The `blockSeparator` argument only applies at block boundaries, so
multi-**paragraph** text serialized correctly (`"para one\npara two"`) and hid
the single-paragraph case.

Why the suite could not see it: the nearest test,
`composer-editor.test.ts:533` `'splits on newlines into hard breaks rather than
corrupting via a bare-string HTML parse'`, asserts on `editor.getText()`, which
walks the document by a different route and *does* return the newline. The
tested path and the shipped path disagreed.

**User impact:** type `line one`, Shift+Enter, `line two`; the composer shows
two lines; the agent receives `line oneline two`, with the last and first words
glued together. Every multi-line message sent with Shift+Enter — the documented
way to insert a newline — was affected. `Mod+Enter` had the identical defect.

**Fix (this task):** `serialize.ts` now returns `'\n'` for `hardBreak`.

**Bound by 5 new tests** in `composer-editor.test.ts`, under
`describe('serializeDocument — Shift+Enter hard breaks reach the wire (matrix
row 10)')`, all asserting through `serializeDocument` rather than `getText()`:
hard break → newline; the words are never glued; multi-line `insertAtCursor`
round-trips; mentions still serialize as `@label` alongside a hard break;
paragraph boundaries unchanged (control).

**Mutation-verified:** removing the one-line fix kills **4 of the 5** new tests
(26 pass / 4 fail) — the fifth is the paragraph control and correctly survives.
Restored; 30 pass.

---

### Row 11 — Typing anywhere on the page focuses the composer

**Verdict: CODE-VERIFIED**

The guard list is identical — `isTextEditingElement` is copied verbatim
(`hooks/use-composer-focus.ts:6-12` ↔ `:399-405`), `isVisible` is the same
`offsetParent !== null`, and the modifier/`key.length !== 1`/`defaultPrevented`
checks match (`use-composer-focus.ts:115-129` ↔ `:405-423`). The new version
adds `el.contains(document.activeElement)`, needed because the target is now a
contenteditable subtree.

Insertion moved from `ta.setRangeText(e.key, start, end, 'end')` to
`onTypeAhead` → `insertAtCursor` → `insertTextAtCursor`
(`composer-editor.tsx:251-261`), which inserts inline at the selection with no
leading paragraph node. That is covered by
`composer-editor.test.ts:495` `'inserting mid-word keeps a single paragraph and
lands exactly at the cursor'` and its deliberate counter-example at `:506` — a
**pure function** test, not the component.

**Open sub-case:** after a raw `el.focus()` (not `view.focus()`), whether
ProseMirror's stored `state.selection` is still the user's pre-blur caret at the
instant `insertContent` runs is DOM timing, not code. The insertion is
synchronous and `selectionchange` is async, so it should hold, but only a
browser settles it.

An earlier iteration of this dropped the keystroke entirely for a non-empty
unfocused composer; that gate is gone (`composer.tsx:717-729` documents the
removal), so the mid-draft case is handled.

---

### Row 12 — `focus-session-textarea` focuses the visible composer

**Verdict: UNVERIFIABLE HERE**

The code is equivalent: the same 10-retry `requestAnimationFrame` chain against
the same `offsetParent` visibility predicate, on the same event name
(`use-composer-focus.ts:94-113` ↔ `:451-467`), plus two additive improvements
(an in-flight chain is cancelled before a new one starts; any pending frame is
cancelled on unmount). The sole dispatcher, `command-palette.tsx:732`, is
untouched.

**Why this row is not CODE-VERIFIED.** The old target — a `<textarea>` — existed
on the component's first render, so the retry loop could not miss. The new
target is behind `React.lazy` + `Suspense` and `immediatelyRender: false`, so
`ref.current` is `null` until the chunk resolves *and* TipTap constructs its
view. Ten animation frames is roughly 160 ms at 60 Hz. This event is a
**one-shot**: if it arrives during a cold-chunk window and the retries are
exhausted, the focus is lost and nothing re-arms it — the effect re-registers
the listener when `editorElement` appears, but it cannot replay a missed event.
This is the row's whole claim, and code reading cannot say how often 160 ms is
too short.

Contrast row 13, which is self-healing: that effect re-runs when the element
appears and focuses then.

**What would verify it:** in Chromium with the network throttled and the cache
disabled, open a session from the command palette (`command-palette.tsx:732`
dispatches `focus-session-textarea`) on a cold load, and assert
`document.activeElement` is the composer's contenteditable. Repeat warm as the
control.

---

### Row 13 — autoFocus when revealed inside a hidden tab

**Verdict: CODE-VERIFIED**

Same shape on both sides (`use-composer-focus.ts:63-82` ↔ `:475-499`): focus
immediately when `offsetParent !== null`, otherwise an `IntersectionObserver`
with `{ threshold: 0.1 }` that focuses and disconnects on first intersection.
The default is byte-identical:
`autoFocus ?? (typeof window !== 'undefined' && window.innerWidth >= 640)`.

The observed element is real and correctly timed:
`composer.tsx:713-716` makes the ref a `useMemo` over `editorElement` (not a
plain `useRef`), specifically so the effect re-runs once the lazy editor
resolves — which is what keeps the reveal case working for a composer that
mounts hidden.

**Delta:** the old code additionally set React's native `autoFocus` attribute on
the `<textarea>` (`:1312`). The new code does **not** pass `autoFocus` to
`ComposerEditorLazy` (`composer.tsx:1198-1213`), even though
`composer-editor.tsx:404` supports `autofocus`. Focus now comes only from the
effect, which cannot run before the chunk resolves — so first-paint focus is
later than before. The mechanism is preserved; only the timing changed, and
unlike row 12 it is self-healing.

---

### Row 14 — Triple-`Esc` stop, with the ×2/×1 hint

**Verdict: CODE-VERIFIED**

`send-stop-control.tsx` is byte-identical (`git diff 1fd281f897..HEAD` empty),
including `{escCount > 0 && …}` and `{escCount === 1 ? '×2 to stop' : '×1 to
stop'}` at `:66-79`. The counter, the 4 s cooloff and the 1→2→3 progression all
live in `session-chat.tsx:3175-3242` and were never inside the composer. The
prop chain is intact: `session-chat.tsx:3963` → `composer.tsx:1249` →
`composer-toolbar.tsx:230` → `SendStopControl`.

**Open sub-case — a narrower first Escape.** Old suppressed Escape only when a
menu had rows (`:932`, `:958`). `@tiptap/suggestion@3.27.1` returns `true` for
Escape whenever the plugin is *active* — including with zero rows shown. So
typing `@zzzzz` (no matches) while the agent is busy now swallows the first
Escape instead of advancing the counter. User-visible as "the first ESC did
nothing".

---

### Row 15 — Sub-session "back to parent" indicator

**Verdict: CODE-VERIFIED**

The whole inline-chips block — the
`{(threadContext || sessionId || inputSlot || replyTo || queuedMessages?.length) &&`
gate, the `mx-3 mt-2.5 flex flex-col gap-1.5 empty:hidden` wrapper, and the
`threadContext` button with its `ArrowUpLeft` icon and `Sub-session of` copy —
diffs **identical** across 51 lines (old `:1135-1185` ↔ `composer.tsx:1084-1134`).
Type and destructure unchanged; `session-chat.tsx:3983` still supplies it.

Note: the `group-hover:` classes on the icon have no `group` ancestor in
*either* version — a pre-existing dead style carried over verbatim, not a
regression. No test.

---

### Row 16 — Reply-to banner and clear

**Verdict: CODE-VERIFIED**

Covered by the same identical-block diff as row 15: same JSX, same 120-character
truncation rule (`composer.tsx:1100`), same `onClearReply` button and aria-label
key (`:1108`). Props unchanged; `session-chat.tsx:3985-3986` still supplies
them. Whether the banner clears on send is parent-owned in both versions. No
test.

---

### Row 17 — Model connection gate bar and hard-disabled send

**Verdict: CODE-VERIFIED**

`noModelsConnected` is textually identical on both sides (`:733-738` ↔
`composer.tsx:761-766`), as is
`submitDisabled = disabled || modelUnavailable || lockForApproval` (`:740` ↔
`:774`) and the `modelUnavailable` toast (`:742-748` ↔ `:897-902`).
`model-connection-gate.tsx`, `use-model-connection-gate.ts` and
`model-availability.ts` are all byte-unchanged.

Plumbing verified: `composer.tsx:1227` passes the **gated**
`availableSelectedModel` (not the raw prop), `:1255`/`:1257` pass
`submitDisabled`/`modelUnavailable`, and `SendStopControl` hard-disables at
`send-stop-control.tsx:123-127` and swaps its aria-label/tooltip to
`NO_MODEL_AVAILABLE_ACTION_MESSAGE`.

`model-availability.test.ts` (protected, unmodified) proves the **helpers** —
`'blocks normal sends when a model is required but missing'`, `'removes a
selected model that is not usable for the account'`. No test renders `Composer`,
`ComposerToolbar`, `SendStopControl` or `ModelConnectionBar`.

**Note (not a gate weakening):** `canSubmit` changed from
`text.trim().length > 0 || attachedFiles.length > 0` to
`!isEmpty || attachedFiles.length > 0` (`composer.tsx:773`). ProseMirror's
`isEmpty` does not trim, so a whitespace-only document now enables the Send
button. `handleSubmit` still trims and no-ops (`:941`), so nothing blank is
sent. The model gate is enforced by `submitDisabled`, not `canSubmit`, so it is
untouched. Self-documented at `composer.tsx:767-772`.

---

### Row 18 — Token progress and context click-through

**Verdict: REGRESSED — FIXED IN THIS TASK. Now PROVEN by mutation.**

(Desktop was never affected; the control was gone below 640 px.)

- **Old** — `composer-toolbar.tsx` rendered `<TokenProgress …/>` bare inside
  `<div className="flex shrink-0 items-center gap-0">`. **No responsive class
  anywhere.**
- **New** — `composer.tsx:1242` passes
  `tokenProgressWrapperClassName="hidden sm:flex"`, and
  `composer-toolbar.tsx:203-211` wraps `TokenProgress` in that div.

**The wrapper was not moved — it is new.**
`git grep -n "hidden sm:flex" 1fd281f897 -- apps/web/src/features/session/`
returns **zero** hits; at `HEAD` it returns exactly one, `composer.tsx:1242`.
The `tokenProgressWrapperClassName` prop is itself added by this rebuild.

`hidden` is `display:none` below the `sm` breakpoint (640 px), so the ring, its
tooltip and its `onClick` are absent from the DOM on a phone or narrow window.
That ring is the **only** entry point to the context modal:
`session-chat.tsx:3425` `handleContextClick = () => setContextModalOpen(true)`
is referenced exactly once, at `:3984`; `setContextModalOpen` has no other
caller (declaration `:1541`, the dialog's `onOpenChange` `:3625`). So below
640 px `SessionContextModal` is unreachable.

`token-progress.tsx` itself is byte-identical and its own doc comment
(`:17-22`) argues against exactly this: *"Deliberately kept visible in BOTH the
simple and advanced composer toolbars … a quiet, non-interactive ring."*
`onContextClick` plumbing is otherwise intact and the ≥640 px rendering is
equivalent.

**This was deliberate, not accidental** — `progress.md:96` lists it as a Task 12
brief item: *"(e) TokenProgress `hidden sm:flex` belongs HERE not T10"*. It is
nonetheless a regression of a matrix row that was never authorized as a
deviation, and it costs mobile users all access to context usage and
compaction.

**Fix (this task).** The `tokenProgressWrapperClassName` prop is removed
outright — from `composer.tsx`'s call site, from `ComposerToolbarProps`, and
from the destructure — and `TokenProgress` renders unwrapped again. That also
deletes the dead `undefined`-wrapper branch and its stale doc comment ("the old
toolbar is still-live"), since `composer.tsx` is now the only `ComposerToolbar`
call site.

**Bound by 3 new tests** in the new `composer/composer-toolbar.test.tsx`,
under `describe('ComposerToolbar — TokenProgress is visible at every viewport
(matrix row 18)')`. They SSR-render the real `ComposerToolbar` with
`renderToStaticMarkup` — the shell `attachment-tiles.test.tsx` and
`projects/project-card.test.tsx` already use, which needs no jsdom and commits
no effects — and assert on the **rendered markup**, never on source text:

1. the ring renders at all (a guard, so the next two cannot pass vacuously);
2. no ancestor of it carries an unprefixed `hidden`;
3. no ancestor carries a breakpoint-gated display class at all
   (`sm:flex`, `md:block`, `max-sm:hidden`, …) — broader than the specific
   regression, so a different spelling of the same idea is also caught.

Ancestors are found by walking the markup with a tag-depth stack and snapshotting
it at the element carrying `data-slot="token-progress"`. That `data-slot` is a
one-line addition to `token-progress.tsx` and is this repo's standard stable
hook — 262 uses across `components/ui/*` — not a test-only marker.

**Mutation-verified:** reintroducing the exact `<div className="hidden sm:flex">`
wrapper kills **2 of the 3** tests; the third is the render guard and correctly
survives, since the ring still renders, just hidden. Reverted; 3 pass.

**An earlier draft of this document claimed no headless assertion was possible
here and recorded the row as CODE-VERIFIED. That was wrong** — the premise, not
the principle. The principle (a test that greps its own source for a class name
is false confidence) still holds; what I missed is that SSR-rendering the
component sidesteps source-grepping entirely. Two providers were needed
(`TooltipProvider`, `QueryClientProvider`), both DOM-free. There was no wall.

Also removed with the prop: the dead `undefined`-wrapper branch and its stale
doc comment ("the old toolbar is still-live"), since `composer.tsx` is now the
only `ComposerToolbar` call site. The rendered element is byte-identical to
base, and `grep -n "hidden sm:|sm:flex|max-sm:hidden" composer/*.tsx` now
matches only explanatory comments.

---

### Row 19 — Session scope toolbar, incl. new-session draft commit

**Verdict: CODE-VERIFIED**

`composer-chat-input.tsx` — which builds `<SessionScopeToolbar … onCommittedDraft={sessionId ? undefined : handleCommittedScope} />`
and folds it into `combinedToolbarSlot` — is **not in the diff at all**.
`composer.tsx:1238` passes `toolbarSlot` to `ComposerToolbar`, which renders it
at `composer-toolbar.tsx:221`, in the same position as before (between
`TokenProgress` and `VoiceRecorder`). `scope/session-scope-toolbar.tsx` is
untouched, including `commitSessionScopeDraft`'s `if (!sessionId)` branch
(`:135-141`) and the init effect at `:211`; its pure halves are tested
(`'commits a new-session draft without calling session replacement'`,
`'commits an unrestricted (null) secrets scope before the first prompt'`).

**The deliberate `session-scope-control.tsx` change is behaviour-preserving.**
The diff is exactly `-<Popover>` → `+<Popover open={open} onOpenChange={onOpenChange}>`
plus two optional props. Radix 1.1.18 resolves this through
`useControllableState`; with `open === undefined` it is uncontrolled, identical
to before. **No caller passes either prop** — the two `SessionScopeToolbar` call
sites (`composer-chat-input.tsx:147`, `session-chat.tsx:3441`) pass neither.

**Note:** the `/set-scope` slash row those props were added for is a no-op —
`composer.tsx:861-889` returns early for `set-scope`, `switch-model`,
`set-reasoning-effort` and `start-voice`. A documented new dead end, not a
regression of the toolbar. The React wiring (effect → `onCommittedDraft` →
`ComposerChatInput`) has no test.

---

### Row 20 — `clearOnSend={false}` does not clear or revoke URLs

**Verdict: CODE-VERIFIED**

Old `:805-812`/`:843` and new `composer.tsx:952-956`/`:972` are the same
`resolveComposerResetOnSend` call, the same `if (reset.clear)` block and the
same `for (const url of reset.urlsToRevoke) URL.revokeObjectURL(url)` loop.
`composer-reset.ts` is unchanged and still returns
`{ clear: false, urlsToRevoke: [] }` for `clearOnSend === false`.

`composer-reset.test.ts` (protected, unmodified) proves the **helper** —
`'clearOnSend=false → clears nothing and revokes no URLs (message survives
navigation)'`. The only consumer, `project-home.tsx:217`, is unchanged.

Three related paths all check out: the staged-command branch keeps its own
`if (clearOnSend)` gate with its per-file revoke loop (`:760-768` ↔ `:912-921`);
the failed-send restore is still gated on `clearOnSend` via
`planFailedSendRecovery`'s `if (!input.clearOnSend) return null`
(`composer-logic.ts:92`, tested); and `revokeObjectURL` call sites match 3-for-3
(`:585/:765/:843` ↔ `composer.tsx:508/917/972`).

---

### Row 21 — Voice transcription appends to existing text

**Verdict: REGRESSED — FIXED IN THIS TASK. Now PROVEN by mutation.**

(It always appended; it did not append the way it used to.)

- **Old** `:1050-1052` —
  `setText(prev => (prev ? \`${prev} ${transcribedText}\` : transcribedText))`.
  Always at the **end of the whole draft**, joined by a single **space**, never
  moving focus.
- **New** `composer.tsx:851-853` — `editorRef.current?.setContent(transcribedText, 'merge')`,
  whose merge branch is `insertContent([{ type: 'paragraph' }, …])` at the
  **current selection**, followed by `editor.commands.focus('end')`.

**Evidence — measured on a real headless editor via the production
`serializeDocument`:**

```
ROW21 separator  OLD="hello transcribed"      NEW="hello\n\ntranscribed"
ROW21 caret      caret parked after "hello" in "hello world"
                 NEW="hello\n\nXX\n world"     (the draft is split at the caret)
```

Three user-visible changes:

1. **Separator.** A space became a block boundary — `hello transcribed` is now
   sent as `hello\n\ntranscribed`.
2. **Insertion point.** Record with the caret parked mid-draft and the
   transcript splits the draft there, instead of appending at the end.
3. **Focus.** `setContent` ends with `focus('end')`; the old `setText` never
   moved focus. `handleTranscription` is the one restore-ish path that does
   **not** use the `withoutStealingFocus` wrapper (`composer.tsx:295`) the
   others do.

**Fix (this task).** `handleTranscription` now builds the next document with
`appendTranscribedText` (`composer-logic.ts`) and writes it through
`setDocumentWithoutStealingFocus` — the same wrapper the failed-send and
question-unlock restores already use, which is what keeps focus where the user
put it. `appendTranscribedText` appends the transcript to the **last block**
with a single leading space, which is what makes the separator a space rather
than a paragraph break. When the last block cannot hold inline text (a list,
blockquote or code block holds child *blocks*, so pushing a text node in would
build an invalid document) it starts a new paragraph instead, with no leading
space.

**Bound by 9 new tests.** Six in `composer-logic.test.ts` under
`describe('appendTranscribedText — voice transcription appends at the end with a space')`
cover the space separator, appending to the end of a multi-paragraph draft
without touching earlier blocks, the empty-composer case, the
non-paragraph-last-block fallback, the empty-transcription no-op, and a mention
atom surviving in the target paragraph. Three more in `composer-editor.test.ts`
assert the serialized result through a real editor: `"hello transcribed"` with
`childCount === 1`, `"hello world dictated"` with the caret parked mid-draft
(the regression produced `"hello\n\ndictated\n world"`), and no leading space
into an empty composer.

**Mutation-verified:** turning the space separator back into a pushed paragraph
kills **5 tests**. Reverted; 70 pass across the two files.

---

### Row 22 — Agent selector locked inside a meta-agent session

**Verdict: CODE-VERIFIED**

`composer.tsx:1225` passes `agentSelectorLocked` to `ComposerToolbar` exactly as
`:1337` did, and `cycleAgent` (`composer.tsx:553-559`) carries the same
`agentSelectorLocked` guard the old Tab branch had at `:982`.

Enforcement lives in files the rebuild barely touched:
`composer-toolbar.tsx:180 disabled={agentSelectorLocked}` →
`agent-selector.tsx:144` `onOpenChange={(next) => setOpen(disabled ? false : next)}`
and `:110` `onSelect={() => { if (disabled) return; … }}`. `agent-selector.tsx`'s
only diff versus base is the new optional `triggerLabelClassName`
(`max-w-[100px]` → `cn('max-w-[100px]', triggerLabelClassName)`) — styling only;
tooltip copy, `aria-disabled` and the gated popover are unchanged. The
meta-agent source (`composer-chat-input.tsx:124-127` → `:213`) is untouched.

**Note:** `composer.tsx:864 case 'switch-agent': cycleAgent()` adds a second
route to change agent (the `/` menu); it goes through the same guard, so it is
locked too. No test — `grep -rn agentSelectorLocked src` returns zero test files.

---

### Row 23 — Sessions match on the files they changed  *(added; not in spec §7)*

**Verdict: PROVEN — by mutation, helper and wiring both**

Old `:669-684` filtered candidate sessions by title, then session id, then
`s.summary?.diffs.some(d => (d.file || '').toLowerCase().includes(q))`, capped
at 5. New `menus/menu-items.ts:50-59` (`sessionMatchesQuery`) is the same three
checks in the same order, applied at `:87-90` after the identical
`!s.parentID && !s.time.archived && s.id !== currentSessionId` filter, with the
same `SESSION_LIMIT = 5`.

**Helper tests:** `menus/menu-items.test.ts:58`
`'matches a session by a changed file path in summary.diffs'` — query
`'auth.ts'`, two sessions with unrelated titles, asserts only the one whose diff
is `src/lib/auth.ts` survives. Plus `:99` `'does not match a session when the
diffs entry has no file field'`.

**Mutation:** deleting the `summary.diffs` branch from `sessionMatchesQuery`
kills exactly 1 test (6 pass / 1 fail). Restored; 7 pass.

**Wiring, read end to end:** `composer.tsx:421` `useRuntimeSessions()` →
`:1195-1196` `sessions={allSessions ?? []}` (unfiltered) →
`composer-editor.tsx:318-321` `sessionsRef` → `:420` `getSessions` →
`mention-controller.ts:75/:96` → `mention-menu.tsx:141 buildMentionSections(…)`.
No filter anywhere on that path.

**Cosmetic delta:** the row description separator changed from `-` to `·`
(`:689` ↔ `menu-items.ts:99`). Triaged as acceptable in §3, item 8.
`formatRelativeTime` also now takes an injected `now` fixed at menu-open time,
so timestamps no longer tick while a menu is open.

---

### Row 24 — The `@` menu lists hidden agents and subagents  *(added; not in spec §7)*

**Verdict: PROVEN — by mutation, helper and wiring both**

Old `:665` filtered the **raw** `agents` prop by name only. The filtered
`primaryAgents` (`:312-314`, `!a.hidden && a.mode !== 'subagent'`) fed Tab
cycling (`:982`) and the toolbar (`:1334`) — never the menu. So hidden agents
and subagents were `@`-mentionable, which is plausibly how a user delegates to a
subagent by name.

New `menus/menu-items.ts:82-84` applies the same name-only filter, with the
decision pinned in a comment at `:73-81`.

**Helper test:** `menus/menu-items.test.ts:86`
`'hidden and subagent agents ARE listed in the @ menu'` — feeds
`{name:'hidden-agent', hidden:true}` and `{name:'sub-agent', mode:'subagent'}`
and asserts both appear.

**Mutation:** inserting `.filter((a) => !a.hidden && a.mode !== 'subagent')`
before the name filter kills exactly 1 test (6 pass / 1 fail). Restored; 7 pass.

**Wiring — the split is preserved exactly:**
`composer.tsx:1194 agents={agents}` (the raw prop) goes to the editor and the
`@` menu; `composer.tsx:1222 agents={primaryAgents}` goes to `ComposerToolbar`
only; `primaryAgents`' only other use is `cycleAgent` (Tab). This mirrors the
old split one-for-one.

**Note:** `AgentSelector` applies its own `!a.hidden && a.mode !== 'subagent'`
filter internally (`agent-selector.tsx:52-55`), so the toolbar double-filters.
Pre-existing and unchanged.

---

## 3. Deferred-item triage

Extracted with
`grep -nE 'deferred|Route to T14|carry to T14' .superpowers/sdd/2026-08-09-enhance-chat-input/progress.md`
— 14 ledger lines, some bundling more than one item.

| # | Item | Source | Verdict |
|---|---|---|---|
| 1 | No co-located test for `use-composer-focus.ts` | T1, `progress.md:4` | Acceptable to ship |
| 2 | `data ?? []` returns a fresh array each render | T2, `:10` | Acceptable to ship |
| 3 | `react-hooks/set-state-in-effect` at `use-debounced-value.ts:21` | T2, `:11` | Acceptable to ship |
| 4 | `keepPreviousData` shows the **previous sandbox's** files | T2, `:14` | **MUST FIX — fixed here** |
| 5 | `trackEmptyBoundary` lifetime / `setContent` before editor / Chrome Android Enter | T3, `:35` | Acceptable to ship |
| 6 | Placeholder test reads `@internal` `decoration.type.attrs` | T3, `:39` | Acceptable to ship |
| 7 | `setEditable()` emits a redundant `update` | T3, `:40` | Acceptable to ship |
| 8 | Session description separator `·` vs `-` | T6, `:49` | Acceptable to ship |
| 9 | Escape now sticks via `dismissedRange`; `slash-items.test.ts` `as never` casts | T8, `:65` | Acceptable to ship |
| 10 | `allowedPrefixes` regex brittleness | T8, `:70` | Acceptable to ship |
| 11 | One-React-tick window where `@` + Enter submits | T8, `:71` | Acceptable to ship |
| 12 | `EMPTY_ACTIONS` seam — `/` menu over staged args | T12, `:118` | **Already resolved in T13** |
| 13 | Type-ahead drops the keystroke when non-empty + unfocused | T12, `:119` | **Already resolved in T13** |
| 14 | `disabled \|\| lockForApproval` duplicated at `:745` and `:1191` | T13, `:140` | **MUST FIX — fixed here** |

Two items (12, 13) were closed by Task 13 before this task ran — `EMPTY_ACTIONS`
is passed at `composer.tsx:1198`, and `insertAtCursor`
(`composer-editor.tsx:251-261`) replaced the dropped keystroke. That leaves 12
genuinely open, of which 2 are fixed here.

### Fixed — item 4: cross-sandbox file results in the `@` menu

**Why blocking.** A composer stays mounted across a session switch
(`session-chat.tsx:1506-1512` pre-mounts every open tab). Switching runtime
changes `server`, which changes the query key — and stock `keepPreviousData`
answers "yes, show the previous data" for *any* previous query, including one
that ran against a different sandbox, with `isLoading: false`. The `@` menu then
presents another workspace's file paths as if they were this one's. Selecting
one produces a `<file_ref>` for a path the agent cannot resolve. Wrong data
presented as authoritative, on the composer's main discovery path.

**Fix** (`composer/hooks/use-file-search.ts`): replaced `keepPreviousData` with a
guard that keeps the placeholder only while the `server` slot of the previous
query key matches the current one. The never-flash-empty behaviour during
typing is unchanged; only the cross-sandbox case is dropped.

One non-obvious detail is captured in the code comment: the guard is written
**inline**, not hoisted to a stable reference, because query-core reuses the
previous placeholder result *without re-consulting the function* whenever the
`placeholderData` option is referentially unchanged
(`queryObserver.js:267` — `prevResult?.isPlaceholderData && options.placeholderData === prevResultOptions?.placeholderData`).
A stable reference would let a cross-sandbox result survive the very switch this
guards against.

**Bound by 8 new tests** in the new `composer/hooks/use-file-search.test.ts`,
asserting the guard against the **real** key builder (`composerFileSearchKey`) so
the guard's index into that tuple cannot drift out of step with the key shape:
same-sandbox-different-query keeps, different-sandbox drops (including for an
identical query), the `unbound` sentinel is its own sandbox and not a wildcard,
no-previous-query drops, and a foreign key shape never matches by accident.

### Fixed — item 14: one definition of "the editor is inert"

**Why blocking.** `disabled || lockForApproval` appeared verbatim in two places
that must agree: `useComposerFocus({ disabled })`, which decides whether a
keystroke typed anywhere on the page is redirected **into** the editor, and the
`ComposerEditorLazy` `disabled` prop, which decides whether the editor accepts
it. They had already drifted once — Task 13, MINOR 2 — and that drift was a real
user-visible bug: with the type-ahead's `isEmpty()` gate removed, a stray
character could land **mid-draft** in a composer locked for a pending connector
approval. The duplication is the defect, and it sits on a surface with no
browser coverage.

**Fix** (`composer/composer.tsx`): hoisted to a single `editorDisabled` local
(`:446`), consumed at `:756` and `:1202`. Zero behaviour change — so no test is
added; the change makes a class of bug structurally impossible rather than
adding behaviour to assert. Verified by grep: the string
`disabled || lockForApproval` no longer appears anywhere in the file.

### Judged acceptable — reasoning

- **1 — no test for `use-composer-focus.ts`.** The hook is 100% DOM-coupled:
  `offsetParent` needs layout, and it uses `IntersectionObserver`,
  `requestAnimationFrame`, `window` listeners and `document.activeElement`. This
  repo registers no jsdom/happy-dom for `bun test`. Its two pure predicates are
  module-private and too small to justify a surface change. Recorded as a real
  coverage gap in §6 instead — it is the single largest one, covering rows 11,
  12 and 13.
- **2 — `data ?? []` fresh each render.** It cannot cause the render loop it
  looks like it could. The only re-render trigger for `MentionMenuHost` from
  this path is `renderer.updateProps({ selectedIndex })`
  (`mention-controller.ts:63`), and `ReactRenderer.updateProps` shallow-compares
  the keys it is given and returns early when nothing changed
  (`@tiptap/react@3.27.1/dist/index.js:704-718`). With `selectedIndex`
  unchanged, no re-render occurs, so the chain cannot sustain. Cost is a
  redundant `buildMentionSections` on renders that happen anyway.
- **3 — `set-state-in-effect` warning.** One more instance of the tolerated
  ~455-warning `react-hooks` family pending a dedicated audit. 0 errors.
- **5 — three sub-items.** `trackEmptyBoundary`'s `wasEmpty` is created once per
  `ComposerEditor` mount via `useMemo(…, [])` and `useEditor` is constructed
  once, so there is no desync path today. `setContent` before editor creation is
  closed for prefill (the `editorReady` guard, PROVEN by mutation); the only
  other caller is voice transcription, which cannot fire before the toolbar's
  mic button has been clicked and a recording has completed. Chrome Android's
  Enter bypass is upstream and unavoidable; the send button covers it.
- **6 — `@internal` decoration read in the placeholder test.** Test-only
  brittleness, disclosed in the test. A public alternative needs a DOM the file
  deliberately avoids. A `prosemirror-view` bump could break it with zero
  functional change; that is a loud, obvious failure, not a silent one.
- **7 — redundant `update` on `setEditable`.** Absorbed by
  `trackEmptyBoundary`'s boundary guard, which only forwards a genuine
  empty↔non-empty transition. Matters only if a future consumer wires `onUpdate`
  directly.
- **8 — `·` vs `-` separator.** `·` is the house convention: 484 occurrences
  across `apps/web/src`. This moves toward the design system, not away from it.
- **9 — Escape sticks; `as never` casts.** The Escape change is a genuine
  behaviour delta (the menu no longer re-opens on the next keystroke) but is
  the better behaviour, and it is bounded by the same trigger text. The casts are
  test hygiene.
- **10 — `allowedPrefixes` regex.** Upstream
  (`findSuggestionMatch.ts:55-58` builds a character class from
  `allowedPrefixes.join('')`), round-0 code, not a regression, and only bites if
  someone adds a prefix containing `-`, `]` or `^`.
- **11 — one-tick `@` + Enter window.** Structural to `ReactRenderer` plus a
  React effect. Requires pressing Enter inside the same React tick that opened
  the menu — under ~16 ms of a human keystroke. The failure mode is benign (the
  message sends, as the old composer did for a zero-row match).

---

## 4. Regressed rows — disposition

All four are fixed. Three restore behaviour that the old implementation
documented in code; the fourth reverses a change that was never authorized as a
matrix deviation.

| Row | Regression | Fix | Bound by |
|---|---|---|---|
| 10 | Shift+Enter line breaks dropped from every sent message | `hardBreak` serializes to `'\n'` | 5 tests; mutation kills 4 |
| 1 | Merge-mode prefill: ordering inverted, dedupe gone, blank lines on files-only | `planPrefillMerge` -> `mergeFailedSubmissionDocument` | 9 tests; two mutations kill 6 and 4 |
| 21 | Voice transcription: block separator, caret insertion, focus steal | `appendTranscribedText` + `setDocumentWithoutStealingFocus` | 9 tests; mutation kills 5 |
| 18 | `TokenProgress` and the only route to the context modal hidden below 640 px | `tokenProgressWrapperClassName` removed entirely | 3 tests; mutation kills 2 |

All four are test-bound and mutation-verified. Row 18 was the doubtful one: an
earlier draft of this document argued no headless assertion was available and
recorded it as CODE-VERIFIED. That was an overstated premise —
`renderToStaticMarkup` SSR-renders the real toolbar with no jsdom, so the
assertion can be made against rendered markup rather than source text. The
principle that motivated the doubt (never let a test grep its own source for a
class name) is preserved; the conclusion drawn from it was wrong.

### Dependency removal

`@tiptap/extension-mention` is removed from `apps/web/package.json`. The
standing constraint was "no new dependencies", and this one earned nothing: the
mention node is hand-built in `composer/editor/mention-node.ts`.

Verified **by symbol**, not by import path — the trap this plan hit twice:
`grep -rn "extension-mention|MentionOptions|MentionPluginKey"` across
`apps/` and `packages/` returns only the `package.json` line itself. After
`pnpm install`, resolution genuinely fails:

```
$ node -e "require.resolve('@tiptap/extension-mention')"
DOES NOT RESOLVE (correct): MODULE_NOT_FOUND
```

The lockfile change is 15 deletions, all `@tiptap/extension-mention`, and
`@tiptap/suggestion` now resolves to a single `3.27.1` entry. All gates were
re-run against the pruned tree, not just against the edited manifest.
`@tiptap/suggestion` stays — it is the one code path both the `@` and `/` menus
register through, and the spec plans for it explicitly. `@tiptap/starter-kit`
also still has zero imports and remains a separate follow-up
(`progress.md:36`).

---

## 5. Protected-suite proof

The six suites named as protected must be **byte-identical** to base across the
whole plan.

```
$ git diff --stat 1fd281f897..HEAD -- '*composer-reset.test.ts' \
    '*composer-draft-recovery.test.ts' '*message-queue-boundary.test.ts' \
    '*queued-messages-logic.test.ts' '*model-availability.test.ts' \
    '*model-flatten.test.ts'
(no output)
```

Empty output alone would also be produced by a glob matching nothing, so the
files were confirmed to exist and their blob hashes compared directly:

| File | base blob | HEAD blob |
|---|---|---|
| `apps/web/src/features/session/composer-reset.test.ts` | `b0b33c28002d` | `b0b33c28002d` |
| `apps/web/src/features/session/composer-draft-recovery.test.ts` | `d97abe1e6465` | `d97abe1e6465` |
| `apps/web/src/features/session/message-queue-boundary.test.ts` | `b9aa841de61a` | `b9aa841de61a` |
| `apps/web/src/features/session/model-availability.test.ts` | `ee2fd387ca66` | `ee2fd387ca66` |
| `apps/web/src/features/session/model-flatten.test.ts` | `d15efbbbb487` | `d15efbbbb487` |
| `apps/web/src/features/session/composer/queued-messages-logic.test.ts` | `78e34729fe12` | `78e34729fe12` |

All six identical. **No protected contract moved.** The same command run against
this task's own working diff is likewise empty, and
`git diff -- '*.test.ts' '*.test.tsx' | grep -c '^-[^-]'` returns `0` — this task
removed no test line anywhere.

`git diff -- packages/sdk` and `git diff 1fd281f897..HEAD -- packages/sdk` are
both empty.

---

## 6. What remains unverified, and exactly what would verify it

Ordered by how much a defect there would cost.

1. **`composer.tsx`'s wiring has no test at all — this is the single largest
   gap on the branch, and it is why 17 rows are CODE-VERIFIED rather than
   PROVEN.** Nothing imports `composer/composer`. Every CODE-VERIFIED row above
   rests on reading the call site, not on a test protecting it. This is
   measured, not assumed: during Task 13 a reviewer replaced the whole
   failed-send recovery with `if (false && …)` and the suite stayed green at
   1340/1340.

   The fixes in this task narrow the gap without closing it. Rows 1 and 21 now
   have their *decision logic* in pure, fully-tested functions
   (`planPrefillMerge`, `appendTranscribedText`) whose output is additionally
   round-tripped through a real editor — so the call site is reduced to a few
   lines that pass values through. But nothing proves `composer.tsx` still
   calls them. Deleting the `handleTranscription` body would leave all 1394
   tests green.

   *Would verify it:* React Testing Library plus a DOM environment for
   `bun test`, or Playwright driving the real composer. Deliberately **not**
   attempted here — building that harness is its own piece of work, not a fix
   round, and doing it badly under time pressure would produce coverage that
   looks like proof and is not.
2. **`use-composer-focus.ts` has no test** — it carries rows 11, 12 and 13.
   *Would verify it:* a DOM environment with `IntersectionObserver` and layout,
   or a browser.
3. **Row 12's cold-load window.** A `focus-session-textarea` event arriving
   while the lazy editor chunk is still loading exhausts the 10-frame retry and
   is lost with no re-arm.
   *Would verify it:* Chromium, cache disabled and network throttled, open a
   session from the command palette, assert `document.activeElement` is the
   contenteditable; repeat warm as a control.
4. **Row 18's actual mobile impact.** Confirmed in code; the layout consequence
   of reverting is not.
   *Would verify it:* the session page at 375 px wide, with and without the
   `hidden sm:flex` wrapper, screenshotting the toolbar.
5. **Row 11's caret position after a raw `el.focus()`.** Whether ProseMirror's
   stored selection is still the user's pre-blur caret when `insertContent`
   runs is DOM timing.
   *Would verify it:* type a draft, click a transcript message, type a
   character, assert it lands at the previous caret.
6. **Row 7's paste focus round-trip.** ProseMirror's `capturePaste` performs a
   ~50 ms hidden-element focus dance on a files-only paste.
   *Would verify it:* paste an image into the composer and watch
   `document.activeElement` across the window.
7. **Row 6's drop over the contenteditable.** The propagation question is
   settled from `prosemirror-view` source (`preventDefault` only, never
   `stopPropagation`); the end-to-end interaction is not.
   *Would verify it:* `dragenter` on the card, a second on the editor, one
   `dragleave` from the editor — assert the overlay is still shown — then drop a
   `DataTransfer` with a file over the contenteditable and assert a tile appears
   with nothing inserted into the document.
8. **Row 3's amber placeholder colour** — a CSS `::before` rule on
   `p.is-editor-empty:first-child`. *Would verify it:* computed style of the
   pseudo-element while `lockForApproval` is true, in both themes.
9. **Row 14's narrowed first Escape.** `@tiptap/suggestion` swallows Escape
   whenever a trigger match is active, including with zero rows, where the old
   composer let it through to the stop counter. *Would verify it:* type `@zzzzz`
   while the agent is running and count the Escapes needed to stop.
10. **ARIA reachability** (`composer.tsx:619-706`). The `MutationObserver` that
    mirrors `aria-controls`/`aria-activedescendant` onto the contenteditable is
    inherently DOM-only. *Would verify it:* a screen reader, or asserting the
    two attributes on the contenteditable while a menu is open.

### One constraint note

The task constraint was "no new dependencies". Six `@tiptap/*` entries were
added to `apps/web/package.json` during the plan. Four
(`extension-bold`, `extension-code`, `extension-italic`, `extensions`) were
already resolved in `pnpm-lock.yaml` at base and are promotions of existing
transitives. **Two were genuinely new packages** — `@tiptap/extension-mention`
and `@tiptap/suggestion` (both absent from the base lockfile, both pinned to
`3.27.1`). `@tiptap/suggestion` is load-bearing: it is the single code path both
the `@` and `/` menus register through, and the spec plans for it explicitly
(§4, "To add: `@tiptap/suggestion`"). **`@tiptap/extension-mention` has zero
imports in `src/`** — the mention node is hand-built in
`composer/editor/mention-node.ts` — so that declaration can be dropped.
Separately, `@tiptap/starter-kit` also has zero imports and was already noted for
removal (`progress.md:36`).

---

## 7. Changes made by this task

| File | Change |
|---|---|
| `composer/editor/serialize.ts` | `hardBreak` serializes to `'\n'` (row 10) |
| `composer/composer-logic.ts` | `textToParagraphs`/`textToDocument` moved here from `composer-editor.tsx`; `planPrefillMerge` (row 1); `appendTranscribedText` (row 21) |
| `composer/composer.tsx` | Merge-mode prefill routed through `planPrefillMerge` (row 1); `handleTranscription` rewritten (row 21); `tokenProgressWrapperClassName` call site removed (row 18); `editorDisabled` hoisted (deferred item 14) |
| `composer/composer-toolbar.tsx` | `tokenProgressWrapperClassName` prop and its dead branch removed; `TokenProgress` always visible (row 18) |
| `composer/editor/composer-editor.tsx` | Imports the shared `textToParagraphs` instead of defining its own |
| `composer/editor/composer-editor.test.ts` | +12 tests: row 10 through `serializeDocument`, plus rows 1 and 21 round-tripped through a real editor |
| `composer/composer-toolbar.test.tsx` | New — 3 SSR-rendered tests asserting nothing hides `TokenProgress` at any viewport (row 18) |
| `composer/token-progress.tsx` | `data-slot="token-progress"` — the repo-standard stable hook the row-18 test locates it by |
| `composer/composer-logic.test.ts` | +11 tests: `planPrefillMerge` and `appendTranscribedText` |
| `composer/hooks/use-file-search.ts` | Placeholder data restricted to the same sandbox (deferred item 4) |
| `composer/hooks/use-file-search.test.ts` | New — 8 tests for the placeholder guard and key shape |
| `apps/web/package.json`, `pnpm-lock.yaml` | `@tiptap/extension-mention` removed |
| `docs/superpowers/specs/…-design.md` | Matrix rows 23 and 24 added |
| This document, `.superpowers/sdd/…/task-14-report.md` | Verification record and working notes |

Net: **1394 tests pass** (from 1360, all additive), tsc at the 15-error baseline
with none in `composer/`, eslint 3 warnings / 0 errors, `packages/sdk` zero
diff, protected suites byte-identical.
