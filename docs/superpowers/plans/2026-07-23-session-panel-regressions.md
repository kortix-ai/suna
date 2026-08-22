# Session Panel Regressions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the session-panel capabilities that became unreachable when Easy became the only panel mode — file opens landing in the panel, file sharing, full-screen preview, the timestamped action stepper, and an opt-in File Explorer.

**Architecture:** Almost nothing was deleted; three gates made working code unreachable. Most tasks re-route existing components rather than building new ones. New logic goes into pure, co-located helper modules (the `easy-panel-logic.ts` pattern) so it is unit-testable without mounting React or a DOM. One shared navigator component replaces two divergent copies.

**Tech Stack:** Next.js 16 (App Router, RSC), React 19, TypeScript, Zustand v5, TanStack Query v5, Tailwind v4, `bun:test`, lucide-react icons, next-intl.

**Spec:** `docs/superpowers/specs/2026-07-23-session-panel-regressions-design.md`

## Global Constraints

- **Worktree:** All work happens in `/Users/jay/root/kortix/suna-bring-regressed-feature` on branch `bring-regressed-feature`. Never edit the primary checkout.
- **Node:** Run `nvm use 22` before any `pnpm` command — the repo's default Node 26 breaks the worktree tooling.
- **Typecheck:** `cd apps/web && npx tsc --noEmit`. There is NO `typecheck` script in this repo — do not invent one. Two pre-existing unrelated errors in `src/lib/template-url.test.ts` are expected baseline noise.
- **Test command:** `cd apps/web && bun test <path>` — `apps/web/package.json:21` defines `"test": "bun test"`, preloading `./test-setup.ts` via `bunfig.toml`.
- **Test framework:** `bun:test`, imports `{ describe, expect, it, beforeEach }` from `'bun:test'`. Tests are co-located next to the module (`foo.ts` → `foo.test.ts`).
- **No test comments beyond the repo's existing style** — the codebase uses block comments to record *invariants and why*, not to narrate what a line does. Match `stores/session-browser-store.test.ts`.
- **Easy stays the only panel mode.** Do not uncomment the `AdvancedPanel` branch in `action-panel/index.tsx`. Advanced code stays intact and compiling.
- **Never write to `viewBySession` from Easy-mode code paths.** `session-layout.tsx` promises Advanced resumes where the user left it. Use `requestFileOpenSilently`, never `requestFileOpen`. This invariant is already pinned by `stores/session-browser-store.test.ts`.
- **Commit after every task.** Do not commit unless the task's tests pass. Do not push and do not open a PR.
- **No AI attribution in commit messages** — no `Co-Authored-By`, no `Generated with`, no session URLs. The message ends after the body.

---

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `apps/web/src/features/session/action-panel/shared/action-navigator.tsx` | The prev/next + timestamp + live-follow navigator, shared by Easy's detail layer and `AdvancedPanel`. Presentation only. |
| `apps/web/src/features/session/action-panel/shared/action-navigator-logic.ts` | Pure index/mode/timestamp reducers behind the navigator. No React, no DOM. |
| `apps/web/src/features/session/action-panel/shared/action-navigator-logic.test.ts` | Unit tests for the above. |
| `apps/web/src/components/app-file-preview-host.tsx` | Mounts `FilePreviewModal` once at the root layout for surfaces with no side panel. |

**Modified**

| Path | Change |
|---|---|
| `apps/web/src/features/session/action-panel/easy/easy-panel-logic.ts` | Add `pathOutput()`; extend the quick-view union with `'files'`. |
| `apps/web/src/features/session/action-panel/easy/easy-panel-logic.test.ts` | Tests for `pathOutput()`. |
| `apps/web/src/features/session/action-panel/easy/easy-panel.tsx` | Consume `fileOpenBySession`; add the Files quick-nav destination; mount the navigator in the step detail. |
| `apps/web/src/features/session/action-panel/easy/file-preview.tsx` | Share control; full-screen routing; glyph disambiguation. |
| `apps/web/src/features/session/action-panel/easy/file-viewer.tsx` | Same three changes as above. |
| `apps/web/src/features/session/action-panel/advanced/advanced-panel.tsx` | Replace its inline navigator with the shared component. |
| `apps/web/src/features/session/open-session-quick-view.ts` | Accept `'files'`. |
| `apps/web/src/stores/kortix-computer-store.ts` | Widen `requestQuickView` / `consumeQuickView` / `pendingQuickView` to include `'files'`. |
| `apps/web/src/features/workspace/command-palette.tsx` | Add the "Open Files" command. |
| `apps/web/src/features/session/header/session-site-header.tsx` | Add the Files header button. |

---

## Task 1: Land file opens in the Easy panel

Regression A. `openPreview` → `openFileInSessionPanel` → `requestFileOpen` writes `fileOpenBySession`, whose only consumer (`SessionFilesExplorer`) Easy never mounts. Fourteen call sites are inert.

`requestFileOpenSilently` already exists at `stores/session-browser-store.ts:122` with tests at `stores/session-browser-store.test.ts:24-40`, and its doc comment names `easy-panel.tsx` as the intended caller. It has no production callers. This task writes that caller and repoints the routing at it.

**Files:**
- Modify: `apps/web/src/stores/file-preview-store.ts:26-38`
- Modify: `apps/web/src/stores/session-browser-store.ts:167-170`
- Modify: `apps/web/src/features/session/action-panel/easy/easy-panel-logic.ts`
- Modify: `apps/web/src/features/session/action-panel/easy/easy-panel.tsx`
- Test: `apps/web/src/features/session/action-panel/easy/easy-panel-logic.test.ts`

**Interfaces:**
- Consumes: `SessionFileOpenRequest { path: string; line?: number; nonce: number }` from `stores/session-browser-store.ts:38-42`; `OutputItem` from `action-panel/shared/derive-panels.ts`.
- Produces: `pathOutput(path: string): OutputItem` — a synthetic file `OutputItem` for a bare sandbox path, mirroring `quickBrowserOutput(apps)` at `easy-panel-logic.ts:30-37`. Later tasks do not depend on it.

- [ ] **Step 1: Write the failing test for `pathOutput`**

Append to `apps/web/src/features/session/action-panel/easy/easy-panel-logic.test.ts`:

```ts
describe('pathOutput', () => {
  it('names the output after the file, not the whole path', () => {
    const out = pathOutput('/workspace/reports/q3-summary.md');
    expect(out.name).toBe('q3-summary.md');
    expect(out.path).toBe('/workspace/reports/q3-summary.md');
    expect(out.kind).toBe('file');
  });

  it('handles a bare filename with no directory', () => {
    expect(pathOutput('notes.txt').name).toBe('notes.txt');
  });

  it('gives each path a distinct outputKey so re-opening re-animates', () => {
    expect(outputKey(pathOutput('/a/one.md'))).not.toBe(outputKey(pathOutput('/a/two.md')));
  });

  it('never reports fresh — a path opened by click is not this run's deliverable', () => {
    expect(pathOutput('/a/one.md').fresh).toBeUndefined();
  });
});
```

Add `pathOutput` to the existing import block at the top of the file (it already imports `outputKey` and `quickBrowserOutput`).

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/web && bun test src/features/session/action-panel/easy/easy-panel-logic.test.ts
```

Expected: FAIL — `pathOutput is not a function` / `SyntaxError: Export named 'pathOutput' not found`.

- [ ] **Step 3: Implement `pathOutput`**

In `apps/web/src/features/session/action-panel/easy/easy-panel-logic.ts`, directly below `quickBrowserOutput` (line 37):

```ts
/**
 * A synthetic `OutputItem` for a bare sandbox path — what a file-path click in
 * the chat produces, where there is no Outputs row to open.
 *
 * Same trick as `quickBrowserOutput`: routing through `handleOpenOutput`
 * instead of a second open funnel means a clicked path inherits the detail
 * layer's ask-for-changes, panel-split default and tracking for free, and
 * cannot drift from how an Outputs row opens the same file.
 *
 * `callID` is the path itself so `outputKey` stays unique per file — two
 * different files clicked in a row must produce two different keys, or the
 * detail layer treats the second as the same detail and skips its animation.
 * `fresh` is deliberately unset: freshness means "this run produced it", and a
 * click says nothing about which run the file came from.
 */
export function pathOutput(path: string): OutputItem {
  return {
    callID: `path:${path}`,
    name: path.split('/').filter(Boolean).pop() ?? path,
    kind: 'file',
    path,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/web && bun test src/features/session/action-panel/easy/easy-panel-logic.test.ts
```

Expected: PASS, all four new cases green alongside the existing suite.

- [ ] **Step 5: Route `openPreview` through the silent request**

In `apps/web/src/stores/file-preview-store.ts`, replace the body of `openPreview` (lines 26-36):

```ts
  openPreview: (filePath, lineNumber) => {
    // Inside a session the file opens in the panel's detail layer — the THING,
    // not the file manager around it (see easy-panel.tsx's handleOpenOutput).
    // `…Silently` because Easy must never write `viewBySession`: that key is
    // Advanced's resume point, and session-layout.tsx promises Easy leaves it
    // untouched. The modal below is the fallback for surfaces with no side
    // panel — the dashboard and project pages.
    const sessionId = getActivePanelSessionId();
    if (sessionId) {
      openFileInSessionPanel(sessionId, filePath, lineNumber);
      return;
    }
    set({ isOpen: true, filePath, lineNumber });
  },
```

In `apps/web/src/stores/session-browser-store.ts`, change `openFileInSessionPanel` (lines 167-170) to use the silent variant:

```ts
export function openFileInSessionPanel(sessionId: string, path: string, line?: number): void {
  useSessionBrowserStore.getState().requestFileOpenSilently(sessionId, path, line);
  useKortixComputerStore.getState().setIsSidePanelOpen(true);
}
```

- [ ] **Step 6: Verify the store invariant still holds**

```bash
cd apps/web && bun test src/stores/session-browser-store.test.ts
```

Expected: PASS — all existing cases, including "requestFileOpenSilently sets the file-open request WITHOUT touching viewBySession".

- [ ] **Step 7: Consume the request in `EasyPanel`**

In `apps/web/src/features/session/action-panel/easy/easy-panel.tsx`:

Add to the import from `./easy-panel-logic` (it already imports `quickBrowserOutput`, `selectPrimaryDeliverable`, `stepForCallId`, etc.): `pathOutput`.

Add to the existing import from `@/stores/session-browser-store`, or create it if absent: `useSessionBrowserStore`.

Then, immediately after the chip-consume effect (the `pendingPrimaryOpenSessionId` effect that ends around line 478), add:

```tsx
  // A file path clicked in the chat, or in a read/write/edit tool card, lands
  // here. Same one-shot handoff shape as the chip- and quick-view-consume
  // effects above, and for the same reason: on desktop this panel stays
  // mounted behind a CLOSED side panel, so subscribing to the request VALUE —
  // not a stable action — is what re-renders us when the click happens.
  //
  // The nonce, not the path, is the guard: clicking the same file twice must
  // re-open it, and `requestFileOpenSilently` bumps the nonce on every call.
  // A ref rather than state — consuming must not itself schedule a render.
  const fileOpenRequest = useSessionBrowserStore((s) => s.fileOpenBySession[sessionId]);
  const lastFileOpenNonce = useRef(0);
  useEffect(() => {
    if (!fileOpenRequest || fileOpenRequest.nonce === lastFileOpenNonce.current) return;
    lastFileOpenNonce.current = fileOpenRequest.nonce;
    // No siblings: a path clicked in prose belongs to no list, so there is
    // nothing for prev/next to page through and the detail earns no nav row.
    handleOpenOutput(pathOutput(fileOpenRequest.path), undefined, 'row');
  }, [fileOpenRequest, handleOpenOutput]);
```

- [ ] **Step 8: Typecheck**

```bash
cd apps/web && npx tsc --noEmit
```

Expected: no new errors. Pre-existing errors elsewhere in the app are out of scope — compare against `git stash && pnpm typecheck` output if unsure.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/stores/file-preview-store.ts \
        apps/web/src/stores/session-browser-store.ts \
        apps/web/src/features/session/action-panel/easy/easy-panel-logic.ts \
        apps/web/src/features/session/action-panel/easy/easy-panel-logic.test.ts \
        apps/web/src/features/session/action-panel/easy/easy-panel.tsx
git commit -m "fix(web): land chat file-path clicks in the Easy panel

openPreview wrote fileOpenBySession, whose only consumer was
SessionFilesExplorer — a surface Easy mode never mounts. Every file-open
affordance in a session (chat paths, read/write/edit/apply-patch tool cards,
show previews) opened the panel and discarded the file, so the user had to
find the matching output card and click a second time.

EasyPanel now consumes the request and opens the file in its detail layer via
handleOpenOutput, so a clicked path opens exactly the way an Outputs row does.
Routing moves to requestFileOpenSilently, which already existed and was
already tested for this caller, keeping viewBySession untouched as Advanced's
resume point."
```

---

## Task 2: Mount the preview modal for surfaces with no side panel

The non-session branch of `openPreview` sets `isOpen: true`, but no mounted component reads `isOpen` — verified across all fourteen `useFilePreviewStore` call sites. Outside a session, clicking a file path does nothing with no feedback.

**Files:**
- Create: `apps/web/src/components/app-file-preview-host.tsx`
- Modify: `apps/web/src/app/layout.tsx` (the root layout — there is no `(app)/layout.tsx`; the app-level singletons `MaintenanceBannerHost`, `LocalhostLinkInterceptor` and `BrowserNoiseGuard` all mount here, around lines 328-372)

**Interfaces:**
- Consumes: `useFilePreviewStore` (`isOpen`, `filePath`, `closePreview`) from `stores/file-preview-store.ts`; `FilePreviewModal` from `@/features/file-viewer`; `workspaceFileSource` from `@/features/files/file-source`.
- Produces: `<AppFilePreviewHost />` — no props. Nothing depends on it.

- [ ] **Step 1: Read the modal's required props**

```bash
sed -n '46,115p' apps/web/src/features/file-viewer/file-preview-modal.tsx
```

Note the exact `FilePreviewModalProps` fields — `isOpen`, `onClose`, `selectedFilePath`, `filePathList`, `currentFileIndex`, `onPrev`, `onNext`, `source`, `panelMode`, and the optional `shareContext` / `extraActions` / `embedded` / `historyLabel`. The host supplies the single-file case: a one-element `filePathList`, index `0`, and no-op `onPrev`/`onNext`.

- [ ] **Step 2: Write the host**

Create `apps/web/src/components/app-file-preview-host.tsx`:

```tsx
'use client';

/**
 * The fallback destination for a file-path click on a surface with NO session
 * side panel — the dashboard, project pages, anywhere outside a session.
 *
 * `file-preview-store` has always had this branch (`set({ isOpen: true })`),
 * but nothing mounted read `isOpen`, so those clicks were silently inert. One
 * host at the app shell resolves it for every such surface at once.
 *
 * Deliberately NOT mounted inside a session: there, `openPreview` returns
 * early into the panel's detail layer and never sets `isOpen`, so this stays
 * closed rather than competing with the panel.
 *
 * No share context — sharing is scoped to a project session, which is exactly
 * what these surfaces lack. `PublicShareLinkButton` is omitted rather than
 * disabled, matching how the session viewers treat unavailable actions.
 */

import { FilePreviewModal } from '@/features/file-viewer';
import { workspaceFileSource } from '@/features/files/file-source';
import { useFilePreviewStore } from '@/stores/file-preview-store';

const NO_OP = () => {};

export function AppFilePreviewHost() {
  const isOpen = useFilePreviewStore((s) => s.isOpen);
  const filePath = useFilePreviewStore((s) => s.filePath);
  const closePreview = useFilePreviewStore((s) => s.closePreview);

  if (!isOpen || !filePath) return null;

  return (
    <FilePreviewModal
      isOpen
      onClose={closePreview}
      selectedFilePath={filePath}
      // One file, so no traversal: prev/next are inert and the modal hides
      // them via its own hasPrev/hasNext derivation from this list's length.
      filePathList={[filePath]}
      currentFileIndex={0}
      onPrev={NO_OP}
      onNext={NO_OP}
      source={workspaceFileSource}
      panelMode="viewer"
    />
  );
}
```

If Step 1 showed a prop name differing from the above, use the real one — the file is the source of truth, not this plan.

- [ ] **Step 3: Mount it in the root layout**

In `apps/web/src/app/layout.tsx`, add the import beside the other feature imports:

```tsx
import { AppFilePreviewHost } from '@/components/app-file-preview-host';
```

Render it alongside the existing app-level singletons — the block containing `<MaintenanceBannerHost />` and `<LocalhostLinkInterceptor />`, around lines 347-372. Match whatever `Suspense`/`lazy` wrapper its immediate neighbours use; several of those hosts are lazily imported, and a client-only modal should not become the reason the root layout ships more eager JS.

The host renders `null` unless `isOpen`, so mounting at the root costs public and marketing routes nothing at runtime.

- [ ] **Step 4: Guard against a double mount**

`/files` routes already mount `FilePreviewModal` through `file-explorer-page.tsx:506` and `drive-explorer.tsx:862`. Confirm those pass their own explicit `isOpen` derived from the explorer store rather than from `useFilePreviewStore`:

```bash
grep -n "isOpen" apps/web/src/features/project-files/components/file-preview-modal.tsx
```

Expected: the project-files wrapper derives `isOpen` from its own explorer store, so the shell host stays `null` on those routes. If it instead reads `useFilePreviewStore`, stop and report — the guard belongs in this task and the design needs a decision.

- [ ] **Step 5: Typecheck**

```bash
cd apps/web && npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/app-file-preview-host.tsx apps/web/src/app/layout.tsx
git commit -m "fix(web): mount the file preview modal outside sessions

file-preview-store's non-session branch set isOpen: true, but no mounted
component read it — all fourteen call sites use openPreview only. Clicking a
file path on the dashboard or a project page did nothing, silently.

One host at the app shell resolves it for every panel-less surface. Inside a
session openPreview returns early into the panel, so the host stays closed."
```

---

## Task 3: Files as an Easy quick-nav destination

Regression E. `SessionFilesExplorer` is complete and wired at `session-layout.tsx:307`, gated behind `showExplorer = !isEasy && …`. Easy has quick-nav for Terminal, Audit and Browser; Files is the only surface with no Easy route.

**Files:**
- Modify: `apps/web/src/stores/kortix-computer-store.ts:139,142,162,352-380`
- Modify: `apps/web/src/features/session/open-session-quick-view.ts:24`
- Modify: `apps/web/src/features/session/action-panel/easy/easy-panel.tsx`
- Modify: `apps/web/src/features/workspace/command-palette.tsx:1013-1020`
- Modify: `apps/web/src/features/session/header/session-site-header.tsx:281-297`
- Test: `apps/web/src/stores/kortix-computer-store.test.ts`

**Interfaces:**
- Consumes: `SessionFilesExplorer` from `@/features/session/session-files-explorer` — props `{ chatSessionId?: string; projectId?: string; projectSessionId?: string }`, all optional.
- Produces: the quick-view union widens from `'terminal' | 'audit' | 'browser'` to `'terminal' | 'audit' | 'browser' | 'files'` across `requestQuickView`, `consumeQuickView`, `pendingQuickView.view` and `openSessionQuickView`. Task 4 does not depend on this.

- [ ] **Step 1: Write the failing test for the widened union**

Append to `apps/web/src/stores/kortix-computer-store.test.ts`, matching the file's existing style:

```ts
  it('carries a files quick-view request through to its consumer', () => {
    const s = useKortixComputerStore.getState();
    s.requestQuickView('files', 's1');
    expect(useKortixComputerStore.getState().pendingQuickView?.view).toBe('files');
    expect(useKortixComputerStore.getState().consumeQuickView('s1')).toBe('files');
  });

  it('clears the files request after one consume', () => {
    const s = useKortixComputerStore.getState();
    s.requestQuickView('files', 's1');
    useKortixComputerStore.getState().consumeQuickView('s1');
    expect(useKortixComputerStore.getState().consumeQuickView('s1')).toBeNull();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/web && bun test src/stores/kortix-computer-store.test.ts
```

Expected: FAIL — a TypeScript union error on `'files'`, or a runtime null from `consumeQuickView`.

- [ ] **Step 3: Widen the union**

In `apps/web/src/stores/kortix-computer-store.ts`, replace every occurrence of the quick-view union with the four-member version. There are four sites — the interface declarations at lines 139 and 142, the state initializer at 162, and the action implementations at 352 and 372:

```ts
  requestQuickView: (view: 'terminal' | 'audit' | 'browser' | 'files', explicitSessionId?: string) => void;
```

```ts
  consumeQuickView: (sessionId: string, now?: number) => 'terminal' | 'audit' | 'browser' | 'files' | null;
```

Apply the same widening to the `pendingQuickView` state type at line 162 and to the implementations' parameter and return annotations. Change no logic — the actions are already view-agnostic.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/web && bun test src/stores/kortix-computer-store.test.ts
```

Expected: PASS.

- [ ] **Step 5: Widen the shared entry point**

In `apps/web/src/features/session/open-session-quick-view.ts`, change the signature at line 24:

```ts
export function openSessionQuickView(
  view: 'terminal' | 'audit' | 'browser' | 'files',
  source: 'palette' | 'header',
): void {
```

No body change. The Advanced branch's `setView(activePanelSessionId, view)` already accepts `'files'`— note that `SessionPanelView`'s `'explorer'` member is the Files surface and `'files'` means *git changes*. Map explicitly in the Advanced branch so the two vocabularies cannot be confused:

```ts
  if (panelMode === 'advanced') {
    if (activePanelSessionId) {
      // `SessionPanelView` calls the file explorer 'explorer'; its 'files'
      // member is the git-changes diff view. The quick-view vocabulary uses
      // 'files' for the explorer, so translate rather than pass through.
      useSessionBrowserStore
        .getState()
        .setView(activePanelSessionId, view === 'files' ? 'explorer' : view);
    }
    useKortixComputerStore.getState().openSidePanel();
  } else {
```

- [ ] **Step 6: Add the Files destination to `EasyPanel`**

In `apps/web/src/features/session/action-panel/easy/easy-panel.tsx`, import the explorer:

```tsx
import { SessionFilesExplorer } from '@/features/session/session-files-explorer';
```

Add `openFiles` next to `openAudit` (around line 530):

```tsx
  /**
   * The opt-in File Explorer (Marko's ask). Never a default view and never a
   * tab — it opens only when asked for, exactly like Terminal and Audit, so
   * Easy keeps its one-home shape.
   *
   * `padded: false` — the explorer owns its own chrome (version header, tabs,
   * toolbar) and would sit inside a second frame otherwise. The layer header
   * stays ON, unlike a file preview: the explorer's own header names a
   * version, not this detail, so there is no duplicate name to collapse.
   */
  const openFiles = useCallback(() => {
    openDetail({
      key: 'files',
      title: 'Files',
      padded: false,
      body: (
        <SessionFilesExplorer
          chatSessionId={sessionId}
          projectId={projectId}
          projectSessionId={projectSessionId}
        />
      ),
    });
  }, [openDetail, sessionId, projectId, projectSessionId]);
```

Extend the quick-view consume effect (around line 566) with the new branch and dependency:

```tsx
    } else if (view === 'browser') {
      openBrowser();
    } else if (view === 'files') {
      openFiles();
    }
  }, [
    pendingQuickView,
    sessionId,
    projectId,
    projectSessionId,
    openTerminal,
    openAudit,
    openBrowser,
    openFiles,
  ]);
```

- [ ] **Step 7: Add the palette command**

In `apps/web/src/features/workspace/command-palette.tsx`, find the block around line 1013 that maps Terminal/Audit/Browser to `openSessionQuickView(view, 'palette')` and add a Files entry beside them, following that block's exact item shape (label, icon, keywords, `onSelect`). Use the `FolderOpen` icon from lucide-react and label it `Open Files`.

- [ ] **Step 8: Add the header button**

In `apps/web/src/features/session/header/session-site-header.tsx`, add a button beside the existing Terminal (line 281) and Browser (line 297) buttons, copying their exact `Button` variant, size, `Hint` wrapper and class names:

```tsx
                onClick={() => openSessionQuickView('files', 'header')}
```

Use the `FolderOpen` icon at the same size the neighbouring buttons use.

- [ ] **Step 9: Typecheck and run the panel suite**

```bash
cd apps/web && npx tsc --noEmit && bun test src/features/session/action-panel src/stores
```

Expected: no new type errors; all panel and store tests pass.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/stores/kortix-computer-store.ts \
        apps/web/src/stores/kortix-computer-store.test.ts \
        apps/web/src/features/session/open-session-quick-view.ts \
        apps/web/src/features/session/action-panel/easy/easy-panel.tsx \
        apps/web/src/features/workspace/command-palette.tsx \
        apps/web/src/features/session/header/session-site-header.tsx
git commit -m "feat(web): opt-in File Explorer in the Easy panel

SessionFilesExplorer was complete and wired but gated behind !isEasy, leaving
Files as the only panel surface with no Easy route. It now opens as a detail
layer from the header and the command palette, the same way Terminal and Audit
already do — opt-in, never a default view, no tab strip.

The quick-view union gains 'files'. openSessionQuickView translates it to
SessionPanelView's 'explorer' for the Advanced branch, since that vocabulary
uses 'files' for the git-changes diff instead."
```

---

## Task 4: Shared action navigator with visible chronology

Regression D. `advanced-panel.tsx:57-134` has timestamps, ←/→ stepping, live-follow and a scrubber; Advanced is unreachable. Extract it so Easy's step detail gains the same behaviour and the two cannot drift.

One deliberate change from the Advanced original: Advanced shows the timestamp only inside the scrubber's hover tooltip. Marko asked to *see* the chronology, so the shared navigator renders it inline as well.

**Files:**
- Create: `apps/web/src/features/session/action-panel/shared/action-navigator-logic.ts`
- Create: `apps/web/src/features/session/action-panel/shared/action-navigator-logic.test.ts`
- Create: `apps/web/src/features/session/action-panel/shared/action-navigator.tsx`
- Modify: `apps/web/src/features/session/action-panel/advanced/advanced-panel.tsx`
- Modify: `apps/web/src/features/session/action-panel/easy/easy-panel.tsx`

**Interfaces:**
- Consumes: `ToolPart` from `@/ui`; `collectToolParts` from `../shared/collect-tool-parts`; `NativeSlider` from `@/components/ui/slider-native`.
- Produces:
  - `clampIndex(index: number, count: number): number`
  - `nextIndex(current: number, count: number): { index: number; mode: 'live' | 'manual' }`
  - `prevIndex(current: number): { index: number; mode: 'manual' }`
  - `actionTimeLabel(part: ToolPart | undefined, now: Date): string`
  - `isEditableTarget(el: HTMLElement | null): boolean`
  - `<ActionNavigator parts={ToolPart[]} index={number} onIndexChange={(i: number, mode: 'live' | 'manual') => void} isLive={boolean} />`

- [ ] **Step 1: Write the failing logic tests**

Create `apps/web/src/features/session/action-panel/shared/action-navigator-logic.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import type { ToolPart } from '@/ui';
import {
  actionTimeLabel,
  clampIndex,
  isEditableTarget,
  nextIndex,
  prevIndex,
} from './action-navigator-logic';

function partAt(ms: number | undefined, key: 'start' | 'end' = 'end'): ToolPart {
  return { state: { time: ms === undefined ? {} : { [key]: ms } } } as unknown as ToolPart;
}

describe('clampIndex', () => {
  it('pins an over-long index to the last action when the list shrinks', () => {
    expect(clampIndex(9, 3)).toBe(2);
  });

  it('never returns a negative index for an empty list', () => {
    expect(clampIndex(4, 0)).toBe(0);
  });
});

describe('nextIndex', () => {
  it('re-arms live-follow on reaching the last action', () => {
    expect(nextIndex(1, 3)).toEqual({ index: 2, mode: 'live' });
  });

  it('stays manual while short of the end', () => {
    expect(nextIndex(0, 5)).toEqual({ index: 1, mode: 'manual' });
  });

  it('does not step past the last action', () => {
    expect(nextIndex(4, 5)).toEqual({ index: 4, mode: 'live' });
  });
});

describe('prevIndex', () => {
  it('pins manual mode so live-follow does not snap the user forward', () => {
    expect(prevIndex(3)).toEqual({ index: 2, mode: 'manual' });
  });

  it('does not step below the first action', () => {
    expect(prevIndex(0)).toEqual({ index: 0, mode: 'manual' });
  });
});

describe('actionTimeLabel', () => {
  const now = new Date('2026-07-23T15:00:00');

  it('shows time only for an action from today', () => {
    const label = actionTimeLabel(partAt(new Date('2026-07-23T14:12:30').getTime()), now);
    expect(label).not.toContain('Jul');
    expect(label.length).toBeGreaterThan(0);
  });

  it('adds the date for an action from another day', () => {
    const label = actionTimeLabel(partAt(new Date('2026-07-21T14:12:30').getTime()), now);
    expect(label).toContain('Jul');
  });

  it('falls back to the start time while an action is still running', () => {
    expect(actionTimeLabel(partAt(new Date('2026-07-23T14:12:30').getTime(), 'start'), now))
      .not.toBe('');
  });

  it('is empty when the action carries no time at all', () => {
    expect(actionTimeLabel(partAt(undefined), now)).toBe('');
    expect(actionTimeLabel(undefined, now)).toBe('');
  });
});

// ─── ←/→ must never steal the caret. Every one of these contexts regressed at
// least once in the original panel, which is why each is pinned separately
// rather than as a single "is it editable" case. ──────────────────────────────

describe('isEditableTarget', () => {
  it('is false for a plain element', () => {
    expect(isEditableTarget(document.createElement('div'))).toBe(false);
  });

  it('is false for no element at all', () => {
    expect(isEditableTarget(null)).toBe(false);
  });

  it('is true for an input', () => {
    expect(isEditableTarget(document.createElement('input'))).toBe(true);
  });

  it('is true for a textarea', () => {
    expect(isEditableTarget(document.createElement('textarea'))).toBe(true);
  });

  it('is true inside a CodeMirror editor', () => {
    const editor = document.createElement('div');
    editor.className = 'cm-editor';
    const inner = document.createElement('span');
    editor.appendChild(inner);
    expect(isEditableTarget(inner)).toBe(true);
  });

  it('is true inside a ProseMirror editor', () => {
    const editor = document.createElement('div');
    editor.className = 'ProseMirror';
    const inner = document.createElement('span');
    editor.appendChild(inner);
    expect(isEditableTarget(inner)).toBe(true);
  });

  it('is true on the scrubber, which handles arrow keys itself', () => {
    const slider = document.createElement('div');
    slider.setAttribute('data-slot', 'slider');
    expect(isEditableTarget(slider)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd apps/web && bun test src/features/session/action-panel/shared/action-navigator-logic.test.ts
```

Expected: FAIL — module `./action-navigator-logic` not found.

- [ ] **Step 3: Implement the logic module**

Create `apps/web/src/features/session/action-panel/shared/action-navigator-logic.ts`:

```ts
/**
 * The pure half of the action navigator — index arithmetic, live-follow mode
 * transitions, timestamp formatting, and the keyboard-suppression predicate.
 *
 * Split out for the same reason as `easy-panel-logic.ts`: every rule here is a
 * behaviour that regressed at least once in the original panel, and each is
 * cheaper to pin as a pure function than by mounting a panel and a DOM.
 */

import type { ToolPart } from '@/ui';

export type FollowMode = 'live' | 'manual';

/** Keep an index inside a list that grew or shrank while it was held. */
export function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(0, index), count - 1);
}

/**
 * Stepping forward onto the LAST action re-arms live-follow: the user has
 * caught up with the stream, so new actions should carry them along rather
 * than stranding them one behind and requiring a second click per action.
 */
export function nextIndex(current: number, count: number): { index: number; mode: FollowMode } {
  const index = Math.min(count - 1, current + 1);
  return { index, mode: index >= count - 1 ? 'live' : 'manual' };
}

/** Stepping back always pins manual — otherwise live-follow yanks the user
 *  forward again on the next streamed action, mid-read. */
export function prevIndex(current: number): { index: number; mode: 'manual' } {
  return { index: Math.max(0, current - 1), mode: 'manual' };
}

/**
 * Wall-clock time the action ran — end if it finished, else start, so a
 * running action still reads as "started at". Same-day actions show the time
 * alone; older ones earn the date, because in a resumed session "2:14 PM"
 * with no day is a lie the user cannot detect.
 *
 * `now` is a parameter, not `new Date()`, so the same-day boundary is testable
 * without freezing the clock.
 */
export function actionTimeLabel(part: ToolPart | undefined, now: Date): string {
  const time = (part?.state as { time?: { start?: number; end?: number } } | undefined)?.time;
  const ms = time?.end ?? time?.start;
  if (typeof ms !== 'number') return '';
  const d = new Date(ms);
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })
    : d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
}

/**
 * Whether a keydown target owns its own arrow keys. The composer, any code or
 * rich-text editor, and the scrubber thumb all do — stepping the navigator
 * from inside one of them would move the caret AND the action, which reads as
 * the app fighting the user.
 */
export function isEditableTarget(el: HTMLElement | null): boolean {
  if (!el) return false;
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.isContentEditable ||
    !!el.closest('.cm-editor') ||
    !!el.closest('.ProseMirror') ||
    !!el.closest('[data-slot="slider"]')
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd apps/web && bun test src/features/session/action-panel/shared/action-navigator-logic.test.ts
```

Expected: PASS, all cases green.

- [ ] **Step 5: Build the navigator component**

Create `apps/web/src/features/session/action-panel/shared/action-navigator.tsx`:

```tsx
'use client';

/**
 * The action chronology bar — prev/next, a scrubber, the position, and the
 * wall-clock time of the focused action, with ←/→ stepping the whole run from
 * start to end.
 *
 * Shared by `AdvancedPanel` and Easy's step detail so the two presentations of
 * the same run cannot drift. It owns no list and no selection: the host holds
 * the index and passes it back down, because the host is also what renders the
 * focused action above this bar.
 *
 * The timestamp renders INLINE, not only in the scrubber's hover tooltip: the
 * chronology is the point, and a time you have to hover to find is a time the
 * user does not have. It appears only after mount — it is locale- and
 * timezone-formatted, so rendering it during SSR is a hydration mismatch.
 */

import { Button } from '@/components/ui/button';
import { NativeSlider } from '@/components/ui/slider-native';
import { cn } from '@/lib/utils';
import type { ToolPart } from '@/ui';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type FollowMode,
  actionTimeLabel,
  isEditableTarget,
  nextIndex,
  prevIndex,
} from './action-navigator-logic';

export function ActionNavigator({
  parts,
  index,
  onIndexChange,
  isLive,
  className,
}: {
  parts: ToolPart[];
  index: number;
  /** Reports both the new index and what it implies for live-follow, so the
   *  host never has to re-derive the mode rule and get it subtly different. */
  onIndexChange: (index: number, mode: FollowMode) => void;
  isLive: boolean;
  className?: string;
}) {
  const count = parts.length;

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const timeLabel = useMemo(() => actionTimeLabel(parts[index], new Date()), [parts, index]);

  const goPrev = useCallback(() => {
    const { index: i, mode } = prevIndex(index);
    onIndexChange(i, mode);
  }, [index, onIndexChange]);

  const goNext = useCallback(() => {
    const { index: i, mode } = nextIndex(index, count);
    onIndexChange(i, mode);
  }, [index, count, onIndexChange]);

  const handleScrub = useCallback(
    (values: number[]) => {
      const next = Math.min(count - 1, Math.max(0, values[0] ?? 0));
      onIndexChange(next, next >= count - 1 ? 'live' : 'manual');
    },
    [count, onIndexChange],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditableTarget(document.activeElement as HTMLElement | null)) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goPrev();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        goNext();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goPrev, goNext]);

  if (count <= 1) return null;

  const atLatest = index >= count - 1;

  return (
    <div
      className={cn(
        'border-border flex shrink-0 items-center gap-2 border-t px-2 py-1.5 pr-3.5',
        className,
      )}
    >
      <div className="flex shrink-0 items-center">
        <Button
          variant="ghost"
          size="icon"
          onClick={goPrev}
          className="hit-area-2 hit-area-r-0"
          disabled={index === 0}
          aria-label="Previous action"
        >
          <ChevronLeft className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={goNext}
          className="hit-area-2 hit-area-l-0"
          disabled={atLatest}
          aria-label="Next action"
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>

      <NativeSlider
        value={[index]}
        min={0}
        max={count - 1}
        step={1}
        onValueChange={handleScrub}
        tooltip={timeLabel ? <span className="tabular-nums">{timeLabel}</span> : undefined}
        className={cn(
          'min-w-0 flex-1',
          '[&_[data-slot=slider-thumb]]:transition-[background-color,border-color,box-shadow]',
        )}
      />

      <span className="text-muted-foreground flex shrink-0 items-center gap-1.5 pl-1 text-xs tabular-nums">
        {mounted && timeLabel && <span className="text-muted-foreground/60">{timeLabel}</span>}
        <span>
          {index + 1}
          <span className="text-muted-foreground/40">/</span>
          {count}
        </span>
        {isLive && atLatest && (
          <span className="bg-primary/60 size-1.5 rounded-full" aria-label="Live" />
        )}
      </span>
    </div>
  );
}
```

- [ ] **Step 6: Adopt it in `AdvancedPanel`**

In `apps/web/src/features/session/action-panel/advanced/advanced-panel.tsx`, delete the inline `timeLabel` memo, `goPrev`, `goNext`, `handleScrub`, the keydown effect, and the entire `{count > 1 && …}` footer JSX. Replace the footer with:

```tsx
      <ActionNavigator
        parts={parts}
        index={safeIndex}
        isLive={isLive}
        onIndexChange={(i, m) => {
          setMode(m);
          setIndex(i);
        }}
      />
```

Add the import:

```tsx
import { ActionNavigator } from '../shared/action-navigator';
```

Remove now-unused imports: `Button`, `NativeSlider`, `ChevronLeft`, `ChevronRight`, and `useCallback` if nothing else uses it. Keep the `parts`, `index`, `mode`, `safeIndex`, `isLive`, clamp effect and `focusedToolCallId` effect exactly as they are.

- [ ] **Step 7: Mount it in Easy's step detail**

In `apps/web/src/features/session/action-panel/easy/easy-panel.tsx`, the `focusedToolCallId` effect (around line 515) opens a step detail whose body is `<ToolParts parts={step.parts} sessionId={sessionId} />`. Wrap that body in a component that holds the index and renders the navigator beneath it.

Add near the other module-level helpers at the bottom of the file:

```tsx
/**
 * A step's tool calls with the chronology bar under them — Marko's ask: arrow
 * keys from start to end of a run, with the wall-clock time of whatever you are
 * looking at.
 *
 * Index and follow-mode live here rather than in `EasyPanel` because they are
 * scoped to one open detail: closing it and opening another must start at the
 * latest action again, and local state gives that for free by unmounting.
 */
function StepDetailBody({ parts, sessionId }: { parts: ToolPart[]; sessionId: string }) {
  const [index, setIndex] = useState(parts.length - 1);
  const [mode, setMode] = useState<FollowMode>('live');

  useEffect(() => {
    if (parts.length === 0) return;
    setIndex((i) => (mode === 'live' ? parts.length - 1 : clampIndex(i, parts.length)));
  }, [parts.length, mode]);

  const safeIndex = clampIndex(index, parts.length);
  const current = parts[safeIndex];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        {current && <ToolParts parts={[current]} sessionId={sessionId} />}
      </div>
      <ActionNavigator
        parts={parts}
        index={safeIndex}
        isLive={mode === 'live'}
        onIndexChange={(i, m) => {
          setMode(m);
          setIndex(i);
        }}
      />
    </div>
  );
}
```

Add the imports:

```tsx
import { ActionNavigator } from '../shared/action-navigator';
import { type FollowMode, clampIndex } from '../shared/action-navigator-logic';
import type { ToolPart } from '@/ui';
```

Change the detail body in the `focusedToolCallId` effect:

```tsx
        body: <StepDetailBody parts={step.parts} sessionId={sessionId} />,
```

- [ ] **Step 8: Run the full panel suite and typecheck**

```bash
cd apps/web && npx tsc --noEmit && bun test src/features/session/action-panel
```

Expected: no new type errors; all action-panel tests pass, including the pre-existing `detail-view.test.tsx` and `easy-panel-logic.test.ts`.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/features/session/action-panel/shared/action-navigator.tsx \
        apps/web/src/features/session/action-panel/shared/action-navigator-logic.ts \
        apps/web/src/features/session/action-panel/shared/action-navigator-logic.test.ts \
        apps/web/src/features/session/action-panel/advanced/advanced-panel.tsx \
        apps/web/src/features/session/action-panel/easy/easy-panel.tsx
git commit -m "feat(web): restore action chronology and arrow-key stepping

Timestamps, live-follow and left/right traversal existed only in AdvancedPanel,
which no route can reach. The navigator is now a shared component: Easy's step
detail gains it, Advanced keeps it, and one implementation means the two cannot
drift if Advanced is ever re-enabled.

The timestamp renders inline rather than only in the scrubber's hover tooltip —
the chronology is the point, and a time you have to hover to find is a time the
user does not have. Index arithmetic, mode transitions and the
keyboard-suppression predicate move to a pure module so each rule that
regressed before is pinned by a test."
```

---

## Task 5: Share and full-screen in the session file viewers

Regressions B and C. The share backend is live and `FilePreviewModal` carries share, history and file traversal — both reachable only from `/files`. Separately, `Maximize2` in the session viewers means *widen the panel*, not *full screen*, which is why the real full-screen reads as missing.

**Files:**
- Create: `apps/web/src/features/session/action-panel/easy/viewer-actions.tsx`
- Modify: `apps/web/src/features/session/action-panel/easy/file-preview.tsx`
- Modify: `apps/web/src/features/session/action-panel/easy/file-viewer.tsx`
- Modify: `apps/web/src/features/session/action-panel/easy/easy-panel.tsx`

**Why a shared module:** `PreviewShell` and `FileViewer` keep deliberately
identical toolbars — "Same actions in the same place for every file — they never
move" (`file-viewer.tsx`). Adding the same share control and the same glyph
change to both by copy-paste is verbatim duplication of a logic block, and the
two would drift the first time either is touched. Both new controls live in one
module that both toolbars import. `DownloadButton` and `OpenInNewTabButton` are
already exported from `file-viewer.tsx` and imported by `file-preview.tsx`, so
this follows the pattern those two set rather than inventing one.

**Interfaces:**
- Consumes: `PublicShareLinkButton` from `@/components/projects/public-share-link-button` — props `{ projectId?: string; sessionId?: string; input: CreateSessionPublicShareInput | null; tooltip?: string; title?: string; className?: string }`. `CreateSessionPublicShareInput.file` is `{ label?: string; path: string }`; `mode` is `'view' | 'interactive'`.
- Produces: `viewer-actions.tsx` exporting `ShareContext`, `<ShareFileButton shareContext? path? fileName />` and `<PanelWidthButton isMobile />`. `FileViewer`, `PreviewShell` and `FilePreview` each gain an optional `shareContext?: ShareContext` prop. No later task depends on these.

- [ ] **Step 1: Create the shared viewer actions**

Create `apps/web/src/features/session/action-panel/easy/viewer-actions.tsx`:

```tsx
'use client';

/**
 * Toolbar controls shared by the panel's two file toolbars — `FileViewer`
 * (text) and `PreviewShell` (everything else).
 *
 * Both toolbars are deliberately identical so the actions never move between
 * file types. That contract only holds if they render the SAME controls, not
 * two copies that drift apart the first time either is touched.
 */

import { PublicShareLinkButton } from '@/components/projects/public-share-link-button';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { useIsExpanded, useToggleExpanded } from '@/stores/kortix-computer-store';
import { ChevronsLeftRight, ChevronsRightLeft } from 'lucide-react';

/** Project-session ids a share link is scoped to. */
export interface ShareContext {
  projectId: string;
  sessionId: string;
}

/**
 * Copy a public, view-only link to this file. Rendered only when the session
 * has project context — a booting or transient session has none, and an
 * omitted control beats a disabled one with no explanation (W4), matching
 * `OpenInNewTabButton` and `CopyImageButton`.
 */
export function ShareFileButton({
  shareContext,
  path,
  fileName,
}: {
  shareContext?: ShareContext;
  path?: string;
  fileName: string;
}) {
  if (!shareContext || !path) return null;

  return (
    <PublicShareLinkButton
      projectId={shareContext.projectId}
      sessionId={shareContext.sessionId}
      input={{ file: { label: fileName, path }, mode: 'view' }}
      tooltip="Copy a public view-only link"
      className="text-muted-foreground hover:text-foreground size-7"
    />
  );
}

/**
 * Widen the side panel to fill the window, and back.
 *
 * This is NOT full screen, and must not borrow full screen's glyph: it changes
 * how much room the panel takes, while the document keeps its own frame.
 * Sharing `Maximize2` between the two is why the real full-screen viewer read
 * as missing rather than as moved.
 *
 * Absent on mobile, where the drawer never reads `isExpanded` and the control
 * would be dead weight.
 */
export function PanelWidthButton({ isMobile }: { isMobile: boolean }) {
  const isExpanded = useIsExpanded();
  const toggleExpanded = useToggleExpanded();

  if (isMobile) return null;

  const label = isExpanded ? 'Restore panel width' : 'Widen panel';

  return (
    <Hint label={label} side="bottom">
      <Button
        variant="ghost"
        size="icon"
        onClick={toggleExpanded}
        aria-label={label}
        className="size-7 active:scale-[0.96]"
      >
        {isExpanded ? (
          <ChevronsRightLeft className="size-3.5" />
        ) : (
          <ChevronsLeftRight className="size-3.5" />
        )}
      </Button>
    </Hint>
  );
}
```

- [ ] **Step 2: Adopt both controls in `PreviewShell`**

In `apps/web/src/features/session/action-panel/easy/file-preview.tsx`:

Add to `PreviewShell`'s props: `shareContext?: ShareContext;`

Render `<ShareFileButton shareContext={shareContext} path={path} fileName={fileName} />` immediately before `<DownloadButton …>`.

Replace the entire `{!isMobile && (<Hint label={isExpanded ? 'Exit full screen' : 'Full screen'} …>…</Hint>)}` block with `<PanelWidthButton isMobile={isMobile} />`.

Import from `./viewer-actions`: `PanelWidthButton`, `ShareFileButton`, and the type `ShareContext`. Remove `Maximize2`/`Minimize2` from the lucide import and `useIsExpanded`/`useToggleExpanded` from the store import if the file has no other use for them — check before deleting; `FilePreview` itself may still read them.

- [ ] **Step 3: Adopt both controls in `FileViewer`**

In `apps/web/src/features/session/action-panel/easy/file-viewer.tsx`, make the identical two swaps: add `shareContext?: ShareContext` to `FileViewer`'s props, render `<ShareFileButton shareContext={shareContext} path={path} fileName={fileName} />` before `<DownloadButton …>`, and replace the panel-width block with `<PanelWidthButton isMobile={isMobile} />`.

`FileViewer`'s `path` is already optional, and `ShareFileButton` returns `null` without one — no extra guard needed at the call site.

- [ ] **Step 4: Thread the share context from `EasyPanel`**

`FilePreview` sits between `EasyPanel` and both toolbars. Add the pass-through prop to `FilePreview`:

```tsx
  /** Forwarded to the toolbar's share control. See `PreviewShell`. */
  shareContext?: { projectId: string; sessionId: string };
```

Forward it to every `PreviewShell` in that file — the rich, loading, error and binary branches — and to the final `FileViewer`. All five call sites take `shareContext={shareContext}`.

In `easy-panel.tsx`, where `handleOpenOutput` builds the file detail body, supply it from the props the panel already receives:

```tsx
          shareContext={
            projectId && projectSessionId
              ? { projectId, sessionId: projectSessionId }
              : undefined
          }
```

This mirrors exactly what `session-files-explorer.tsx` already does for `SandboxFileExplorer`.

- [ ] **Step 5: Typecheck**

```bash
cd apps/web && npx tsc --noEmit
```

Expected: no new errors. A missed `shareContext` forward shows up here as an unused-prop or missing-prop error.

- [ ] **Step 6: Verify no dead affordances and no leftover duplication**

```bash
grep -rn "Maximize2\|Minimize2\|PublicShareLinkButton" apps/web/src/features/session/action-panel/easy/
```

Expected: `PublicShareLinkButton` appears only in `viewer-actions.tsx`; `Maximize2`/`Minimize2` no longer appear in `file-preview.tsx` or `file-viewer.tsx`. Any remaining hit in those two files means a toolbar was missed and the two have already drifted.

`ShareFileButton` returns `null` without a share context, so no disabled-with-no-explanation control can reach the toolbar.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/session/action-panel/easy/viewer-actions.tsx \
        apps/web/src/features/session/action-panel/easy/file-preview.tsx \
        apps/web/src/features/session/action-panel/easy/file-viewer.tsx \
        apps/web/src/features/session/action-panel/easy/easy-panel.tsx
git commit -m "feat(web): share links and honest full-screen labels in session file viewers

The public file-share backend and its viewer route were always live; the only
UI entry point lived in FilePreviewModal, mounted solely on /files. Sharing a
file from inside a session was impossible. Both session viewers now carry the
control, omitted rather than disabled where the session has no project context.

The panel-width toggle also stops borrowing the full-screen glyph. Widening the
panel and opening a document full screen are different actions, and sharing
Maximize2 between them is why the real full-screen read as missing rather than
as moved."
```

---

## Task 6: Runtime verification and diagnosis

Regressions F and G. F is believed fixed by `bd05a6590` (#5213) the same morning it was reported; G could not be reproduced from source — every PDF/CSV/PPTX renderer is wired and routed. Both need the running app, and G's fix is specified only after its cause is known.

This task ships no feature code unless Step 5 finds a defect.

**Files:**
- Modify: `docs/superpowers/specs/2026-07-23-session-panel-regressions-design.md` (record outcomes)

- [ ] **Step 1: Boot the worktree stack**

```bash
nvm use 22
cd /Users/jay/root/kortix/suna-bring-regressed-feature && pnpm worktree start
```

If the web app 500s on boot, copy the gitignored `apps/web/.env.keys` from the primary checkout and re-run — a missing keyfile breaks middleware. If a workspace package fails to resolve, run `pnpm install` to relink.

- [ ] **Step 2: Verify Task 1 end to end**

In a session, click a file path in an assistant message. Then click the file link on a `read` tool card, and on a `write` tool card.

Expected: each opens that file in the panel's detail layer on the FIRST click. Note which, if any, still need a second click.

- [ ] **Step 3: Verify Tasks 3, 4 and 5**

- Open Files from the session header and from the command palette. The explorer mounts as a detail with its version header and both tabs.
- Click a step in Progress, then press ← and → repeatedly. The focused action changes, the position and timestamp update, and the Live dot appears only at the latest action.
- Focus the composer and press ←/→. The caret moves; the action does not change.
- Open a file, click the share control, paste the copied URL in a private window. It renders read-only.
- Confirm the panel-width control reads "Widen panel", not "Full screen".

- [ ] **Step 4: Verify LaTeX (Regression F)**

Send a session message containing each of:

```
Inline $E = mc^2$ and display $$\frac{a}{b}$$
Standard delimiters \(x^2\) and \[y^2\]
Currency: $4M and $50K stay literal.
```

plus a ` ```math ` fence and a ` ```latex ` fence.

Expected: all math renders through KaTeX; `$4M` and `$50K` stay literal text. Record the result in the spec's section F — closed by #5213, or a captured failing case, in which case LaTeX leaves this plan and gets its own spec.

- [ ] **Step 5: Diagnose rich inline previews (Regression G)**

With DevTools open — Console and Network both recording — open a real `.pdf`, `.csv` and `.pptx` through BOTH paths: the inline `show` card in the chat, and the Easy panel's file preview. Six combinations.

For each, capture: whether it renders, any console error, any failed request, and the rendered element's computed height.

The four hypotheses to discriminate between, in the order they are cheapest to test:

1. **Zero-height container** — `tool-part-renderer.tsx`'s `fillsPanel` applies `h-full` only when `surface === 'panel' && (tool === 'show' || tool === 'show-user')`. Inspect the renderer's computed height; a mounted element at `0px` confirms it.
2. **Lazy-chunk failure** — the `@extend-ai/*` viewers are `lazy()` imports. A chunk 404 in Network confirms it.
3. **PDFium wasm** — `apps/web/package.json`'s `postinstall` copies `pdfium.wasm` into `public/`, with `|| true` so it fails silently. Check `public/pdfium.wasm` exists; a 404 on it confirms it.
4. **Sandbox fetch** — a failed file-content request surfacing as the generic "This file couldn't be opened" empty state, which is indistinguishable from a renderer bug in the UI.

Record the finding in the spec's section G. If a cause is identified, fix it in this task with a test where the defect is testable, and commit separately. If all six render correctly, record G as not reproducible and note that the original report likely reflected a transient sandbox failure.

- [ ] **Step 6: Commit the findings**

```bash
git add docs/superpowers/specs/2026-07-23-session-panel-regressions-design.md
git commit -m "docs: record runtime verification results for panel regressions"
```

---

## Self-Review

**Spec coverage**

| Spec item | Task |
|---|---|
| A — file opens dead-end | Task 1 |
| A — orphaned modal branch | Task 2 |
| B — file sharing | Task 5 |
| C — full-screen + glyph ambiguity | Task 5 |
| D — chronology and arrow keys | Task 4 |
| E — opt-in File Explorer | Task 3 |
| F — LaTeX verification | Task 6, Step 4 |
| G — rich preview diagnosis | Task 6, Step 5 |
| Unit 1 "consume like the existing precedents" | Task 1, Step 7 |
| Unit 3 "one implementation, two consumers" | Task 4, Steps 6–7 |
| Unit 4 "omitted, not disabled" | Task 5, Step 6 |

No spec item is unassigned.

**Deviations from the spec, and why**

- Spec Unit 1 proposed a new consumer; `requestFileOpenSilently` turned out to already exist with tests and a doc comment naming `easy-panel.tsx` as its intended caller. Task 1 writes the missing caller instead of new store plumbing — strictly less code.
- Spec Unit 3 described the timestamp as inline. `AdvancedPanel` had since moved it into the scrubber's hover tooltip. The shared navigator renders it both ways, since Marko's ask was to *see* the chronology.

**Type consistency**

`FollowMode` is the single name for `'live' | 'manual'` across `action-navigator-logic.ts`, `action-navigator.tsx`, `advanced-panel.tsx` and `StepDetailBody`. `shareContext` is `{ projectId: string; sessionId: string }` at every site, matching `session-files-explorer.tsx`. `pathOutput` returns `OutputItem`, which `handleOpenOutput` already accepts.

**Known plan risks**

- Task 2, Step 2 writes `FilePreviewModalProps` from a partial read. Step 1 exists to correct it against the file, and says the file wins.
- Task 3, Steps 7–8 describe the palette and header edits rather than quoting them, because both blocks have surrounding item shapes an out-of-context quote would break. Each names the exact file, line and neighbouring code to copy.
- Task 5, Step 4 touches five `PreviewShell` call sites in one file. A missed one is a typecheck error, not a silent bug.
