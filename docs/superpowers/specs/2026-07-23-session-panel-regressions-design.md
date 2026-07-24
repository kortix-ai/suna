# Session panel regressions — restoration design

**Date:** 2026-07-23
**Branch:** `bring-regressed-feature`
**Status:** Spec, awaiting review
**Scope:** Restoration only. Session-chat decluttering (removing Progress/Context
cards, thinning step density) is deliberately **out of scope** and belongs in its
own spec.

---

## Why this exists

Marko reported a cluster of regressions in the session panel across two days
(2026-07-21 and 2026-07-22). Read individually they look like five unrelated
features going missing. Read against the code they are mostly **one structural
cause with several symptoms**, plus two genuinely separate gaps.

The cause: PR #4120 (`614010f82`, *Easy/Advanced session panel, rebuilt file
viewers, modular tool renderers*) introduced a two-mode panel, and the follow-up
Easy Panel v2 work disabled Advanced mode entirely. Neither step deleted the
surfaces Advanced owned — it gated them. Easy then became the only mode, so
every surface behind that gate became unreachable while remaining fully
implemented, tested, and imported.

Three separate gates are involved:

| Location | Effect |
|---|---|
| `apps/web/src/features/session/session-layout.tsx:118-122` | `effectiveView` is forced to `'actions'`; `showBrowser`/`showExplorer`/`showTerminal`/`showAudit` are all `&&`-ed with `!isEasy` |
| `apps/web/src/features/session/session-layout.tsx:357` | `effectivePanelHeader = booting \|\| isEasy ? null : panelHeader` — the tab strip is not rendered in Easy mode |
| `apps/web/src/features/session/action-panel/index.tsx:19, 80-88` | The `AdvancedPanel` import and its entire render branch are commented out |

The mode toggle that would escape Easy lives inside the header that gate two
suppresses. **Advanced mode is therefore unreachable by any route**, and with it
the action stepper, the Files explorer, and the engineer tabs.

This is good news for cost: most of the work below is re-routing, not rebuilding.

---

## Regression inventory

Each item records the reported symptom, the verified cause, and the evidence.
Items are ordered by user impact.

### A — File opens are a dead end

> "Clicking links used to open the output directly in the right side. Now it
> doesn't. Now I have to manually click it again, like twice."
> "I just see it in the little show previews, and I can't see it in the right
> sidebar/panel anymore."

**Cause.** A request with no consumer.

`stores/file-preview-store.ts` → `openPreview(filePath, lineNumber)` branches on
whether a session panel is active:

```ts
const sessionId = getActivePanelSessionId();
if (sessionId) {
  openFileInSessionPanel(sessionId, filePath, lineNumber);
  return;
}
set({ isOpen: true, filePath, lineNumber });
```

The comment directly above that branch states the intended behaviour: *"Inside a
session, files open in the side panel's Files tab (inline, with an Expand
button) rather than this full-screen modal. The modal is the fallback for
surfaces with no side panel."* That contract is exactly what the Easy gate
broke — the store still routes to a Files tab that Easy never renders.

`openFileInSessionPanel` (`stores/session-browser-store.ts:167`) writes
`fileOpenBySession` and opens the side panel. That entry is read in exactly one
place — `session-files-explorer.tsx`'s `fileOpenReq` effect — and
`SessionFilesExplorer` is never mounted in Easy mode (gate one). The panel
therefore opens onto the Easy home and the requested file is discarded without
error.

This is the single cause behind three reported symptoms. Every file-open
affordance in a session funnels through `openPreview`:

- a file path clicked in chat markdown — `components/markdown/unified-markdown.tsx:32`
- `read` / `write` / `edit` / `apply-patch` / `memory` tool card file links —
  `tool/tools/*.tsx`
- the shared tool infrastructure's path handler — `tool/shared/infrastructure.tsx:1291`
- a `show` preview's open action — `tool/shared/show-helpers.tsx:128`
- the session files list — `session-files-panel.tsx:73`

All of them are inert. The "click twice" Marko describes is the user recovering
manually: the panel did open, so they hunt for the matching output card in the
Easy home and click that instead.

**Second defect, same store.** The non-session branch sets `isOpen: true`, but
**no mounted component reads `isOpen`**. Verified by grepping every
`useFilePreviewStore` consumer: all fourteen call sites use `openPreview` only.
Outside a session — dashboard, project pages — clicking a file path does nothing
at all, with no feedback.

### B — File sharing has no entry point

> "the File Sharing feature is gone (u could share unique file links with others
> etc…)"

**Cause.** Backend intact, affordance orphaned.

The backend is fully alive:

- `apps/api/src/projects/routes/public-shares.ts`
- `apps/api/src/shared/session-public-shares.ts`
- `packages/db` table `project_session_public_shares`
- public viewer at `apps/web/src/app/(public)/share/session/[token]/public-file-share-view.tsx`
- read-only enforcement covered by `apps/api/src/__tests__/unit-public-session-share.test.ts`

The UI affordance is `PublicShareLinkButton`
(`components/projects/public-share-link-button.tsx`), consumed at
`features/file-viewer/file-preview-modal.tsx:349`. `FilePreviewModal` is mounted
only by `project-files/file-explorer-page.tsx:506` and
`project-files/drive-explorer.tsx:862` — both on the standalone `/files` route.

The session's own viewers — `action-panel/easy/file-preview.tsx` (`PreviewShell`)
and `action-panel/easy/file-viewer.tsx` (`FileViewer`) — have no Share control.
Sharing a file from inside a session is impossible even though the session
explorer already threads a `shareContext` for exactly this purpose
(`session-files-explorer.tsx`, passed to `SandboxFileExplorer`).

### C — Full-screen file preview is unreachable, and its glyph is ambiguous

> "The opening preview full screen file button is also gone."

**Cause.** Two different affordances share one icon; the real one is unmounted.

`FilePreviewModal` (`features/file-viewer/file-preview-modal.tsx`) is a genuine
full-screen viewer carrying four capabilities that exist nowhere else in a
session:

| Capability | Line |
|---|---|
| Public share link | `:349` |
| Version history popover (commits / checkpoints) | `:327-334` |
| Prev/next file across a file list, with ←/→ keys | `:196-215` |
| Download through the injected `source` | `:265` |

Unreachable from a session, per B.

Separately, the `Maximize2` button in `easy/file-viewer.tsx` and
`easy/file-preview.tsx` reads as "full screen" but calls `toggleExpanded()` from
`kortix-computer-store` — it widens the side panel to 100%. Panel-expand and
document-full-screen are two distinct affordances currently signalled by one
glyph, which is why the real full-screen reads as missing rather than as moved.

### D — Action chronology and keyboard traversal

> "ur missing the chronology with timestamps we had in the past on the actions
> … I think that should be back. So u can ARROW KEY from start to end through
> all the actions."

**Cause.** Present in Advanced; Advanced is unreachable (gate three).

The original implementation was `session-actions-panel.tsx`, deleted by #4120.
Its successor `action-panel/advanced/advanced-panel.tsx` retains the behaviour in
full:

- wall-clock timestamp per action — `:57-64`
- `ArrowLeft` / `ArrowRight` window keydown, suppressed inside inputs,
  textareas, `contentEditable`, `.cm-editor` and `.ProseMirror` — `:125-134`
- live-follow with clamp on list growth — `:43`
- jump-to-latest when scrolled back

None of it is reachable. Easy's Progress card lists steps but carries no
timestamps and no keyboard traversal.

### E — No opt-in File Explorer

> "I think id still appreciate a complete optin-able File Explorer somewhere."

**Cause.** Built, wired, gated off.

`SessionFilesExplorer` is complete: a version header, an "All files" tab backed
by the same Drive-style explorer `/files` uses (writable, searchable), a
"Changes" tab backed by `SessionDiffViewer`, its own scoped `FilesStoreProvider`,
and `shareContext` plumbing. It is mounted at `session-layout.tsx:307` — behind
`showExplorer = !isEasy && effectiveView === 'explorer'`.

Easy has quick-nav routes for Terminal, Audit and Browser (`easy-panel.tsx`
`openTerminal`, `openAudit`, `openBrowser`). Files is the **only** panel surface
with no Easy-mode route.

### F — LaTeX — already fixed, verification only

> "LaTex support is gone entirely"

**Status: believed closed. No implementation work in this spec.**

The session chat renders through `UnifiedMarkdown`
(`session-chat.tsx:3`), which applies `katexRemarkPlugins` and
`buildKatexRehypePlugins` (`unified-markdown.tsx:758-759`). `katex-markdown.ts`
handles delimiter normalisation, currency-dollar escaping, and rehype ordering so
`rehype-sanitize` cannot strip KaTeX output.

That file was last changed **2026-07-23** by `bd05a6590` — *feat(web): support
standard LaTeX markdown delimiters (#5213)*. Marko reported the problem at
04:37 the same morning. The most likely reading is that #5213 is the fix and the
report predates it.

This spec therefore carries a **verification task only** (see Unit 5). If
verification fails, LaTeX becomes a new spec rather than being folded in here.

**Verification outcome (2026-07-24, code-level):** Confirmed closed at the code
level. `bd05a6590` (#5213) is present in the branch history, and the KaTeX
plugins are still wired into `UnifiedMarkdown` — the actual chat renderer —
at `unified-markdown.tsx:758-759` (`remarkPlugins={katexRemarkPlugins}`,
`rehypePlugins={buildKatexRehypePlugins(...)}`). The delimiter-normalisation and
currency-escaping pipeline in `katex-markdown.ts` is intact. Nothing in this
restoration touched the math path. A live visual render check (Unit 5b) remains
the only thing not yet done, but the code is provably correct; F requires no
code change here.

### G — Rich inline previews (PDF / CSV / PPTX) — diagnosis required

> "some other little preview, like the show preview, is also gone for the PDF,
> CSV, and PPT doc. The inline preview is also gone."

**Status: not reproducible from source. Requires runtime diagnosis.**

Stated plainly: the machinery is present and I could not find a missing wire.

- `features/file-renderers/show-content-renderer.tsx` has live, lazily-imported
  branches for PDF (`:513`), CSV/TSV (`:533`), XLSX (`:548`), DOCX (`:564`) and
  PPTX (`:582`).
- `show-type-utils.ts:43-47` classifies all five categories, with extension
  regexes that override a mislabelled `type` from the tool payload.
- `easy/file-preview.tsx` `RICH_CATEGORIES` includes `pdf`, `docx`, `pptx`,
  `xlsx`, `csv`, `sqlite`, `video`, `audio`, `image` and routes them to
  `FileContentRenderer` rather than the text-only `FileViewer`.

Plausible runtime causes, none confirmed: a lazy-chunk load failure in the
vendored `@extend-ai/*` viewers; the self-hosted PDFium wasm asset failing to
resolve; a sandbox fetch failure surfacing as the generic "couldn't be opened"
empty state; or the `fillsPanel` height path
(`tool-part-renderer.tsx`, `surface === 'panel' && tool === 'show'`) collapsing
the renderer to zero height so it is mounted but invisible.

Guessing a fix here would be worse than diagnosing one. Unit 5 defines the
reproduction protocol and its acceptance criteria; the fix is specified after
the protocol produces an actual error.

**Static triage (2026-07-24) — three of four hypotheses ruled out from code:**

1. **PDFium wasm — RULED OUT.** `apps/web/public/pdfium.wasm` is present (4.6 MB)
   and the `postinstall` copy step is intact in `apps/web/package.json`. The
   PDF-specific "wasm failed to resolve" cause does not hold in this checkout.
2. **Zero-height `fillsPanel` container — NOT REPRODUCED.** `tool-part-renderer.tsx:120`
   computes `fillsPanel = surface === 'panel' && (tool === 'show' || tool === 'show-user')`
   and `:187` applies `h-full` when it is true; `show-tool.tsx` applies `h-full`
   on the panel/fill branch (`:139`, `:167`, `:190`). The height chain reads as
   intact — no collapsed container visible statically.
3. **Renderer wiring — INTACT.** All five rich branches are present and lazily
   imported as recorded above; nothing is unwired.

That leaves **the sandbox fetch / lazy-chunk-at-runtime hypotheses**, neither of
which can be confirmed or denied without a live session: a `@extend-ai/*` chunk
404, or a file-content request failing and surfacing as the generic
"couldn't be opened" empty state, are both runtime-only signals. **Conclusion:
G needs a live repro (Unit 5a) with a real PDF/CSV/PPTX in an authenticated
session and DevTools open — it cannot be closed from source.** If that repro
shows all six combinations rendering, G is recorded as "not reproducible,
likely a transient sandbox failure at report time."

---

## Design

### Unit 1 — Honour the file-open request

**Problem.** `fileOpenBySession` has exactly one consumer, and that consumer is
never mounted in the only panel mode that ships.

**The fix was already designed.** `session-browser-store.ts:122` exports
`requestFileOpenSilently` — a variant that sets the file-open request *without*
writing `viewBySession`, with three passing tests at
`session-browser-store.test.ts:24-40` and a doc comment reading: *"For callers
that mount their own `SessionFilesExplorer` in place (Easy mode's own file
drill-in — see `easy-panel.tsx`)."*

`easy-panel.tsx` never calls it. Grepping the whole repo finds no production
consumer at all — only the store, its type, and its tests. The store plumbing
for this exact fix was written and tested; the consumer was never wired. That
shrinks Unit 1 to writing the missing caller.

**Approach.** Make the *panel* honour the request, not one surface within it.
`EasyPanel` subscribes to `fileOpenBySession[sessionId]` and opens the requested
path in its detail layer, then consumes the request. `openFileInSessionPanel`
repoints from `requestFileOpen` to `requestFileOpenSilently`, so Easy stops
writing `viewBySession` and Advanced keeps its resume point.

This is a third instance of a pattern `EasyPanel` already implements twice — it
consumes `pendingPrimaryOpenSessionId` and `pendingQuickView` with the same
nonce-guarded shape (`action-panel/index.tsx:56-77`). No new mechanism is
introduced; the discard contract documented there extends to a third key.

The existing nonce guard on `fileOpenBySession` is preserved so that clicking the
same path twice re-opens it rather than being deduplicated into a no-op.

**Second half — the orphaned modal branch.** Mount `FilePreviewModal` once at the
app shell so the non-session branch resolves. The alternative — deleting the
branch — would leave file paths outside a session as inert text, which is a
silent failure. Mounting it is the smaller change and removes a real dead end.

**Boundaries.** `file-preview-store` keeps its current public surface
(`openPreview` / `closePreview`); no call site changes. The store stays the one
place that decides *where* a file opens, which is what makes fourteen call sites
correct at once.

**Testing.** Unit tests on the consume predicate (pure, no DOM — same shape as
`easy-panel-logic.ts` and `shouldDiscardPendingPrimaryOpen`): a request for this
session opens and consumes; a request for another session is ignored; a repeated
nonce does not re-open; a repeated path with a fresh nonce does.

### Unit 2 — Files as an Easy detail layer

**Problem.** The one panel surface with no Easy route.

**Approach.** Add Files as a fourth Easy quick-nav destination beside Terminal,
Audit and Browser, rendering the existing `SessionFilesExplorer` in the detail
layer with its `shareContext` intact. Reachable from the panel header and from
the command palette, consistent with how Terminal and Audit are already reached.

Marko asked for it to be "opt-in-able" — under this design it is opt-in in the
sense that matters: it is never the default view, it opens only when asked for,
and Easy remains the single mode. It does not reintroduce a tab strip.

**Boundaries.** `SessionFilesExplorer` is used unmodified. Its scoped
`FilesStoreProvider` keeps per-session navigation state independent, which is
already correct for a detail layer that mounts and unmounts.

**Testing.** The explorer's own behaviour is already covered. New coverage is the
route: opening Files sets the expected detail state, closes the terminal layer
(matching `easy-panel.tsx`'s existing mutual-exclusion rule at `:253-265`), and
survives a session switch without leaking state across sessions.

### Unit 3 — Shared action navigator

**Problem.** Chronology and keyboard traversal exist only in an unreachable mode.

**Approach.** Extract the navigator from `advanced-panel.tsx` into a shared
component and consume it from both panels.

```
┌─ detail ────────────────────────────┐
│  [tool call, expanded, uncapped]    │
│                                     │
├─────────────────────────────────────┤
│  ‹     12/47 · 2:14 PM · ● Live   › │
└─────────────────────────────────────┘
         ← / →  steps through all actions
```

The component owns: the ordered action list, current index, live/manual mode,
wall-clock timestamp of the focused action, prev/next, jump-to-latest, and the
window keydown handler with its input-suppression rules. It takes the action
list and a render slot; it does not know which panel is hosting it.

Two consumers — Easy's detail layer, and `advanced-panel.tsx` — means the
behaviour cannot drift if Advanced is re-enabled later.

**Details preserved from the original.** The timestamp is rendered only after
mount, because it is locale- and timezone-formatted and would otherwise produce
an SSR hydration mismatch (`session-actions-panel.tsx:67-70` documented this;
`advanced-panel.tsx` carries it forward). Keydown ignores `INPUT`, `TEXTAREA`,
`contentEditable`, `.cm-editor` and `.ProseMirror`, and bails on any modifier
key, so ←/→ never steals the caret from the composer.

**Boundaries.** Pure presentation over a list plus an index. The action list
itself continues to come from `shared/collect-tool-parts.ts`, which both panels
already share.

**Testing.** Index clamping when the list grows or shrinks mid-stream;
live-follow re-engaging at the last index; keydown suppressed inside each of the
five editable contexts; timestamp absent before mount and present after.

### Unit 4 — Toolbar parity in the session viewers

**Problem.** Two missing affordances and one ambiguous glyph.

**Approach, three parts:**

1. **Share.** Add a Share control to `PreviewShell` and `FileViewer`, wired to
   `PublicShareLinkButton`. The backend needs no change. It is omitted — not
   disabled — where no share context exists, consistent with the W4 rule already
   applied to `OpenInNewTabButton` and `CopyImageButton` in these files.

2. **Full screen.** Route the full-screen affordance to `FilePreviewModal`, which
   brings version history and prev/next file traversal with it.

3. **Disambiguate the glyph.** Panel-expand (`toggleExpanded`) and
   document-full-screen are different actions and must not share `Maximize2`.
   Concretely: full-screen keeps `Maximize2` / `Minimize2` and its
   `Full screen` / `Exit full screen` labels; panel-expand moves to
   `ChevronsLeftRight` / `ChevronsRightLeft` labelled `Widen panel` /
   `Restore panel width`, matching the horizontal-axis meaning of the existing
   `PanelRight` toggle in the session header. This ambiguity is the reason C was
   reported as missing rather than as moved.

**Boundaries.** `PreviewShell` and `FileViewer` already share a toolbar contract
— same actions, same order, same position, so controls never move between file
types. Both additions respect that contract rather than adding a per-type
special case.

**Testing.** Share control present with a share context and absent without;
full-screen opens the modal with the correct path; the two controls are
distinguishable by accessible name (`Full screen` vs the panel-expand label) so
the ambiguity cannot silently return.

### Unit 5 — Diagnosis tasks

Two verification tasks. Neither prescribes a fix in advance.

**5a — Rich inline previews (G).** Against the running worktree, with a live
sandbox, open a real `.pdf`, `.csv` and `.pptx` from a session through both
paths: the inline `show` card in chat, and the Easy panel's file preview.
Capture the browser console, the network tab, and the rendered DOM for each.

Acceptance: a named root cause with a specific file and line, or a confirmation
that all six combinations render correctly and the report reflects an
already-fixed state. If a root cause is found, the fix is specified and
implemented under this unit.

**5b — LaTeX (F).** Render inline `$…$`, display `$$…$$`, `\(…\)`, `\[…\]`, and
```` ```math ```` / ```` ```latex ```` fences in a session chat message on the
current branch, plus a currency case (`$4M`) to confirm the escaping still holds.

Acceptance: all render correctly, and F is recorded as closed by #5213 — or a
failing case is captured, in which case LaTeX leaves this spec and gets its own.

---

## Non-goals

- Removing the Progress and Context cards. Jay's, planned, separate spec.
- Reducing session-chat step density.
- Re-enabling Advanced mode. Easy remains the single mode; every restored
  capability lands in Easy. Advanced stays commented out and intact so the
  decision remains reversible.
- Consolidating `features/files`, `features/project-files`, `features/file-viewer`
  and `features/file-renderers`. Real debt, unrelated to these regressions.
- Any change to the public share backend or its permissions model.

---

## Risks

**The Easy detail layer accumulates responsibilities.** After this spec it hosts
outputs, apps, steps, Audit, Terminal, Files and the action stepper. That is the
correct destination for each, but `easy-panel.tsx` is already 690 lines and its
detail state is a single discriminated union. If Unit 2 or Unit 3 makes that
union hard to follow, extract the detail router before adding to it rather than
after.

**Unit 5a may find nothing.** The inline previews may already work, and the
report may reflect a transient sandbox failure. That outcome is acceptable and
should be recorded as such — a spec that says "verified working" is more useful
than one that quietly drops the item.

**Mounting `FilePreviewModal` at the app shell adds a global.** It is already
mounted twice on `/files` routes; a third, shell-level mount must not double up
when a user is on `/files`. Guard on the store, not on the route.

---

## Evidence index

Every claim above traces to a file at the branch point `d6eb2cdbd`:

| Claim | Evidence |
|---|---|
| Easy gates four surfaces | `session-layout.tsx:118-122` |
| Tab strip suppressed in Easy | `session-layout.tsx:357` |
| Advanced branch commented out | `action-panel/index.tsx:82-88` |
| File-open request has one consumer | `session-files-explorer.tsx` `fileOpenReq` effect |
| Request written but dropped | `session-browser-store.ts:167`, `file-preview-store.ts:26-36` |
| Modal branch has no consumer | all 14 `useFilePreviewStore` call sites use `openPreview` only |
| Fix designed but never wired | `requestFileOpenSilently` at `session-browser-store.ts:122`, tested at `session-browser-store.test.ts:24-40`, zero production callers |
| Share button orphaned | `file-viewer/file-preview-modal.tsx:349`, mounted only at `file-explorer-page.tsx:506` and `drive-explorer.tsx:862` |
| Share backend live | `apps/api/src/projects/routes/public-shares.ts`, `(public)/share/session/[token]/` |
| Chronology exists in Advanced | `advanced/advanced-panel.tsx:57-64`, `:125-134` |
| Original implementation | `session-actions-panel.tsx` @ `614010f82^` |
| Explorer built and gated | `session-files-explorer.tsx`, `session-layout.tsx:307` |
| LaTeX plugins active | `unified-markdown.tsx:758-759`, `katex-markdown.ts` |
| LaTeX fixed today | `bd05a6590` (#5213), 2026-07-23 |
| Rich renderers wired | `show-content-renderer.tsx:513,533,548,564,582`; `easy/file-preview.tsx` `RICH_CATEGORIES` |
| Regression source | `614010f82` (#4120), 2026-07-17 |
