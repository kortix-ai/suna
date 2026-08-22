# Composer draft persistence — design

Date: 2026-08-23
Status: proposed, awaiting approval
Surface: `apps/web`

## 1. Problem

Composer text that has been typed but not sent lives only in the live TipTap
editor. It is lost on:

- a page refresh (deliberate or accidental),
- a tab crash or an OS-level app kill,
- a back-navigation away from the project or session,
- an in-app route change that unmounts the composer.

The user must retype the prompt. Long prompts are the common case on this
surface, so the loss is expensive.

There is no persistence at any of the three composer mount sites.

| Mount site | File | Scope key available |
| --- | --- | --- |
| Project home hero composer | `apps/web/src/features/workspace/project-layout/project-home.tsx:245` | `projectId` |
| Instant session boot shell | `apps/web/src/features/session/instant-session-shell.tsx:231` | `sessionId`, `projectId` |
| Live session composer | `apps/web/src/features/session/session-chat.tsx:4867` | `sessionId`, `projectId` |

All three render `Composer` (`features/session/composer/composer.tsx`), the
first two through the `ComposerChatInput` wrapper.

### What already exists and does not solve this

Three in-memory hand-off mechanisms exist. None survives a reload.

- `stores/composer-prefill-store.ts` — one-shot seed from the onboarding
  wizard, the `?q=` deep link, and the command palette. In-memory zustand.
- `stores/session-composer-handoff-store.ts` — `useCarriedDraftStore` carries a
  draft across ONE component swap (boot shell → `SessionChat`). In-memory.
- `features/session/composer-draft-recovery.ts` — merges a failed submission
  back into the editor. Operates on live values, stores nothing.

## 2. Decisions taken before design

| Decision | Choice | Rationale |
| --- | --- | --- |
| Durability | Browser-local (`localStorage`) | Survives refresh, crash, tab close, navigation. No backend work. Cross-device sync is a separate project. |
| Local attachments | Dropped silently on restore | A `local` `AttachedFile` holds a live `File` and a blob object URL. Neither survives a reload. |
| Verification | `bun test` + `tsc --noEmit` + `eslint` | Per the operator's standing no-browser-verification rule. No Playwright journey, no stack boot. |
| Code placement | `apps/web` | `@kortix/sdk` owns what talks to the backend. A TipTap `JSONContent` document is a web-app concept the SDK has no type for, and the composer lives entirely in `apps/web`. |

## 3. Constraints discovered in the code

These four constraints shape the design. Each is load-bearing.

**C1 — the editor is render-silent while typing.**
`ComposerEditor` passes `trackEmptyBoundary` as its only `onUpdate` handler
(`editor/composer-editor.tsx:456`, `:554`). `onEmptyChange` therefore fires
exactly twice per draft: once on the first character, once when the last is
deleted. This is what stops the toolbar re-rendering per keystroke. A save
path that lifts document text into React state destroys that property.

*Consequence:* the save must hang off the TipTap `update` event and write
through a ref-held debounce timer. It must set no React state.

**C2 — mentions are atom nodes, not text.**
`getContent().mentions` is a one-way projection derived by walking the document
for `mention` atoms (`editor/serialize.ts`). `setContent(text)` only builds
plain paragraphs via `textToParagraphs`. Restoring from a plain string
therefore flattens every mention to literal `"@label"` text, and the next send
emits no `<file_ref>` / `<agent_ref>` / `<session_ref>` block — those are built
from the structured mentions array, not from the text.

*Consequence:* the persisted payload is the `JSONContent` from
`getDocument()`. Restore goes through `setDocument()`.

**C3 — the shared `localStorage` bucket has a documented failure history.**
`lib/storage/managed-storage.ts:1-28` records the incident: per-sandbox cache
keys grew unbounded until the bucket saturated, and the next `setItem` from any
store threw `QuotaExceededError` synchronously and crashed the render. The
module is the single chokepoint that prevents a repeat.

*Consequence:* drafts must be written through `ScopedCache`, which stamps each
entry, prunes its family to the N most-recent scopes on every write, and
registers the family as disposable so a full bucket evicts drafts instead of
throwing.

**C4 — the project-home composer does not clear on send.**
`project-home.tsx:258` passes `clearOnSend={false}`, and
`composer-reset.ts` returns `{ clear: false, urlsToRevoke: [] }` for that case:
the send navigates the composer away, and the text rides to the new session via
the start-stash.

*Consequence:* clearing the project draft key on send cannot be tied to the
editor clearing. It is an explicit call on the send path.

## 4. Design

### 4.1 New module: `features/session/composer/draft/`

Two files, plus tests.

**`composer-draft.ts` — pure functions, no DOM, no storage.**

```ts
export type DraftScope =
  | { kind: 'project'; projectId: string }
  | { kind: 'session'; sessionId: string };

export interface StoredDraft {
  /** Envelope version. A bump invalidates every stored draft. */
  v: 1;
  /** Supabase user id of the author. See §4.4. */
  u: string;
  /** The ProseMirror document, mention atoms intact. */
  doc: JSONContent;
  /** Remote attachments only — `local` ones are not serializable. */
  files: Extract<AttachedFile, { kind: 'remote' }>[];
}

export function draftScopeKey(scope: DraftScope): string;
export function serializeDraft(input: {
  doc: JSONContent;
  documentIsEmpty: boolean;
  files: readonly AttachedFile[];
  userId: string;
}): StoredDraft | null;
export function deserializeDraft(raw: unknown, currentUserId: string): StoredDraft | null;
export function shouldRestoreDraft(input: {
  hasPrefill: boolean;
  editorReady: boolean;
  alreadyRestored: boolean;
  editorIsEmpty: boolean;
}): boolean;
```

There is deliberately no `isDraftDocumentEmpty` helper. Emptiness has exactly
one canonical definition in this codebase — `editor.isEmpty` — and
`composer-draft-recovery.ts:38-44` already records why a second implementation
must not be written. `serializeDraft` takes `documentIsEmpty` from the caller,
which holds the live `ComposerEditorHandle.isEmpty()`.

`serializeDraft` returns `null` for an empty document with no remote files —
the caller treats `null` as "remove the key", so emptying the editor deletes
the draft rather than storing an empty one.

`deserializeDraft` returns `null` on a version mismatch, a malformed payload,
or a `u` that does not match the current user (§4.4).

Every function above is testable under `bun test` with no DOM. This mirrors the
existing pattern in this directory: `trackEmptyBoundary`,
`createSubmitOnEnterHandler`, `getEditorDocument`, `setEditorDocument` and
`insertTextAtCursor` were all extracted from React closures for exactly this
reason (`editor/composer-editor.tsx:187-195`, `:244-256`).

**`composer-draft-store.ts` — the storage seam.**

```ts
const draftCache = new ScopedCache<StoredDraft>('kortix_draft', 50);

export function readDraft(scope, userId): StoredDraft | null;
export function writeDraft(scope, draft: StoredDraft | null): void; // null removes
export function clearDraft(scope): void;
```

`ScopedCache` (`lib/storage/managed-storage.ts`) is used unchanged. It already
provides the timestamp stamping, the prune-to-cap on every write, and the
`registerDisposableFamily` call that lets a saturated bucket evict drafts
rather than crash.

Keys produced: `kortix_draft:project:<projectId>` and
`kortix_draft:session:<sessionId>`. Cap 50 scopes.

The 128 KB per-draft size cap is enforced in `serializeDraft`, not here:
`serializeDraft` returns `null` when its own `JSON.stringify` output exceeds
the cap, so one giant paste is simply never stored, and the store layer keeps a
single meaning for `null` ("remove the key"). Placing the cap in the pure
function also makes it testable without storage (test 12, §6).

### 4.2 Save path

`ComposerEditor` gains one optional prop:

```ts
/** Fires on every document change, unthrottled. The host debounces. */
onDocChange?: (doc: JSONContent) => void;
```

It is invoked from the existing `handleUpdate` closure alongside
`trackEmptyBoundary`, through a ref (`onDocChangeRef`) so a changing callback
identity never re-creates the editor — the same discipline the file already
applies to `onEmptyChange`, `onSubmit`, `disabled` and `placeholder`
(`editor/composer-editor.tsx:308-316`).

`Composer` holds the debounce in a `useRef` timer, 400 ms trailing. The timer
callback reads `editorRef.current.getDocument()` and the current
`attachedFiles`, serializes, and writes. It sets no React state, so C1 holds.

Flush points, all calling the same write directly and cancelling the timer:

- `visibilitychange` when `document.visibilityState === 'hidden'`,
- `pagehide`,
- component unmount.

`beforeunload` is deliberately not used: iOS Safari does not fire it reliably,
and `pagehide` covers the same transition on every browser.

### 4.3 Restore path and precedence

Restore runs at most once per scope key, gated by `shouldRestoreDraft`. It
fires on the first render where `editorElement != null` — the same readiness
signal the existing prefill effect uses (`composer.tsx:786`).

Precedence, highest wins:

1. **Failed-send recovery** (`composer-draft-recovery.ts`) — the text the user
   just tried to send.
2. **Explicit prefill** — `?q=` deep link, onboarding hand-off, command
   palette, carried draft from the boot shell.
3. **Stored draft.**

A stored draft is restored only when there is no prefill for this mount AND the
editor is empty. Writing it uses `setDocumentWithoutStealingFocus`
(`composer.tsx`), which already exists and restores the previously-focused
element when the editor was not focused. Without it, a session-page mount would
yank focus into the composer.

Remote attachments in the payload are appended to `attachedFiles`. Local
attachments were never stored, so nothing is restored for them and nothing is
reported.

### 4.4 Multi-user on one browser

Sign-out is called from three places — `features/providers/auth-provider.tsx:141`,
`features/layout/user-menu-shared.tsx:226`, and
`features/workspace/command-palette.tsx:1599` — and two of them call
`supabase.auth.signOut()` directly rather than through the provider. A
"clear drafts on sign-out" hook wired to one of them would silently miss the
other two, and would miss session expiry entirely.

Instead each draft carries the author's Supabase user id in `StoredDraft.u`,
read from `useAuth().user.id`. `deserializeDraft` returns `null` when it does
not match the current user. A second user on the same browser therefore never
sees the first user's draft, on every sign-out path and on expiry, with no
sign-out wiring at all. Stale entries age out through the `ScopedCache` cap.

This matters because project access is shared: two teammates on one machine can
both legitimately open the same project route.

### 4.5 Clear path

The draft key is removed when:

- a send succeeds — explicit `clearDraft(scope)` on the send path, not derived
  from the editor clearing, because of C4;
- the editor becomes empty — the debounced write serializes to `null`, which
  removes the key;
- the `ScopedCache` cap evicts it (deleted sessions, > 50 scopes).

A refused send (`/` command blocked, connector gate, attachment guard) does NOT
clear the draft. Those paths already keep the text in the editor.

### 4.6 Explicitly out of scope

- **Live cross-tab sync.** Two tabs on one session are last-write-wins. A
  `storage`-event merge would fight the local editor for cursor position.
- **Cross-device sync.** Requires a backend draft record; a separate project.
- **Persisting local file attachments.** Would need IndexedDB with its own
  quota and eviction rules.
- **Time-based expiry.** The 50-scope recency cap bounds growth on its own.

## 5. Files touched

| File | Change |
| --- | --- |
| `features/session/composer/draft/composer-draft.ts` | new — pure logic |
| `features/session/composer/draft/composer-draft.test.ts` | new — unit tests |
| `features/session/composer/draft/composer-draft-store.ts` | new — `ScopedCache` seam |
| `features/session/composer/editor/composer-editor.tsx` | add `onDocChange` prop + ref, call from `handleUpdate` |
| `features/session/composer/composer.tsx` | debounce, flush listeners, restore effect, clear-on-send |
| `features/session/composer-chat-input.tsx` | thread the draft scope through |
| `features/workspace/project-layout/project-home.tsx` | pass project draft scope |
| `features/session/instant-session-shell.tsx` | pass session draft scope |
| `features/session/session-chat.tsx` | pass session draft scope |

`ComposerEditorProps.onDocChange` is optional, so the marketing demo composers
(`components/home/interactive-demo-section.tsx:284`,
`components/home/interactive-demo/pages/chat-page.tsx:62`) are untouched and
persist nothing.

## 6. Testing

Per §2, `bun test` + `tsc --noEmit` + `eslint`. No browser.

Unit tests in `composer-draft.test.ts`:

1. `draftScopeKey` produces distinct keys for project and session scopes.
2. `serializeDraft` returns `null` for an empty document with no remote files.
3. `serializeDraft` drops `local` attachments and keeps `remote` ones.
4. A document containing a `mention` atom round-trips through
   serialize → deserialize with the atom node intact — the C2 regression guard.
5. `deserializeDraft` returns `null` on a version mismatch.
6. `deserializeDraft` returns `null` when `u` does not match the current user.
7. `deserializeDraft` returns `null` on malformed JSON.
8. `shouldRestoreDraft` returns `false` when a prefill is present.
9. `shouldRestoreDraft` returns `false` when already restored once.
10. `shouldRestoreDraft` returns `false` when the editor is non-empty.
11. `shouldRestoreDraft` returns `true` only on ready + empty + no prefill +
    not yet restored.
12. A draft over the 128 KB cap is rejected by `serializeDraft`.

`composer-draft-store.test.ts` drives `ScopedCache` against a stub storage to
assert the 50-scope prune and that `writeDraft(scope, null)` removes the key.

Gates before merge: `pnpm test -- --packages-only` scoped to `apps/web`,
`tsc --noEmit` in `apps/web` (clean apart from the ~15 known `@types/bun`
`test.each` errors listed in `CLAUDE.md`), and `npx eslint` on every touched
file with zero errors.

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| Per-keystroke work regresses composer typing performance | The save writes through a ref timer and sets no React state. `onDocChange` is called from the existing `onUpdate`, adding one ref read per keystroke and one `setTimeout` reset. |
| A restore steals focus on a session page mount | `setDocumentWithoutStealingFocus`, already in `composer.tsx`. |
| A stored draft overwrites a deep-link prefill | `shouldRestoreDraft` returns `false` whenever a prefill is present; precedence is asserted in tests 8-11. |
| `localStorage` saturation crashes an unrelated store | `ScopedCache` + `safeSetItem`, the existing chokepoint. Drafts are a registered disposable family. |
| A teammate on a shared machine sees another user's draft | `StoredDraft.u` user-id stamp, checked on every read (§4.4). |
| Mentions flatten to plain text on restore | The payload is `JSONContent`, restored via `setDocument`. Test 4 is the regression guard. |
