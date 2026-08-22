# React Doctor apps/web Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise the React Doctor health score of `apps/web` (currently **40/100 "Critical"**, 87 errors / 2,168 warnings / 639 files) by fixing the vetted highest-leverage findings: dead dependencies, dead code, session-hot-path re-renders, correctness errors, hot-path accessibility, and duplicated utilities.

**Architecture:** Every finding below was machine-detected by `react-doctor@0.8.1` and then human-vetted at its exact `file:line` (false positives are excluded and listed). Tasks are ordered so noise-reduction (dead deps, dead files) lands first — it shrinks the diagnostic surface for everything after. Each task is independently shippable and ends with the same verification gate.

**Tech Stack:** Next.js 15.5 App Router, React 19, TanStack Query 5, Zustand 5, `motion` (motion/react), bun test, TypeScript 5.9.

**Audit evidence:** React Doctor JSON report was generated read-only; canonical fix recipes fetched from `https://www.react.doctor/prompts/rules/<plugin>/<rule>.md`. Plan stamped at commit `df19f59d8`.

## Global Constraints

- Working directory for all commands: `apps/web` (repo: `/Users/jay/root/kortix/suna-react-doctor`).
- Verification gate for EVERY task (run all three, all must pass before the task's commit):
  1. `npx tsc --noEmit`
  2. `bun test --isolate`
  3. `npx react-doctor@latest --verbose --scope changed` → the targeted diagnostics are gone and the score did not regress.
- NEVER add `eslint-disable` / suppression comments to silence a diagnostic — fix or explicitly skip per this plan.
- Do NOT remove the dependency `@embedpdf/pdfium` — it is a confirmed react-doctor false positive (used by the `postinstall` script to copy `pdfium.wasm` into `public/`; removing it breaks the PDF viewer).
- Do NOT delete `src/lib/empty-module.ts` (webpack alias in `next.config.ts:124`) or `test-setup.ts` (bun test preload in `bunfig.toml`) — confirmed unused-file false positives.
- Per repo rules: no AI attribution trailers in commit messages. Commit per task, message format `fix(web): …` / `chore(web): …` as given in each task.
- i18n: user-visible strings in this codebase go through `useTranslations('hardcodedUi')` — `aria-label` values added in Task 7 may be plain English string literals (they are attributes, not rendered text; follow the existing pattern of the file you edit — if neighboring `aria-label`s use `tHardcodedUi.raw(...)`, do the same).

---

### Task 1: Remove 13 dead dependencies

`framer-motion` has **zero** imports in `src/` (all motion code imports from `motion/react`). The other 12 were flagged by `deslop/unused-dependency` and each was individually confirmed unused (no import anywhere, including config files and scripts).

**Files:**
- Modify: `apps/web/package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing later tasks rely on.

- [ ] **Step 1: Confirm each dependency is still unimported (guards against drift since the audit)**

```bash
cd apps/web
for dep in framer-motion three @react-three/fiber @react-three/drei @tiptap/extension-bubble-menu @pierre/trees rehype-harden rehype-raw rehype-katex shaders remark-math remark-parse unist-util-visit; do
  echo "== $dep =="
  rg -n "from ['\"]$dep|require\(['\"]$dep|import\(['\"]$dep" src next.config.ts middleware.ts 2>/dev/null || echo "no imports"
done
```

Expected: `no imports` for every one. Notes: `rehype-katex`/`remark-math` appear only in comments in `src/components/markdown/katex-markdown.ts` (they are provided transitively by `streamdown`); the real shader package is `@paper-design/shaders-react`, not `shaders`. If any dep DOES show a real import, leave that dep in place and continue with the rest.

- [ ] **Step 2: Remove the dependencies**

```bash
cd apps/web
pnpm remove framer-motion three @react-three/fiber @react-three/drei @tiptap/extension-bubble-menu @pierre/trees rehype-harden rehype-raw rehype-katex shaders
pnpm remove -D remark-math remark-parse unist-util-visit
```

(If any of the dev three are in `dependencies` instead of `devDependencies`, remove them from wherever they live.)

- [ ] **Step 3: Verify install + build integrity**

```bash
cd apps/web && pnpm install && npx tsc --noEmit && bun test --isolate
```

Expected: PASS. Also confirm `public/pdfium.wasm` still exists after install (postinstall ran).

- [ ] **Step 4: Run the react-doctor gate**

```bash
npx react-doctor@latest --verbose --scope changed
```

Expected: `deslop/unused-dependency` no longer fires for the removed packages; score not regressed.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore(web): remove 13 unused dependencies (framer-motion, three stack, tiptap bubble-menu, rehype/remark leftovers)"
```

---

### Task 2: Delete dead code (~224 unreachable files)

`deslop/unused-file` flagged 226 files. The analyzer does transitive reachability from App Router entry points; a 13-file spot-check across directories found only 2 false positives (both build/test infra, excluded in Global Constraints) and **zero** false positives among React components/hooks/features. Confirmed-dead clusters include the entire `src/components/tabs/` subsystem and the 23 `src/components/pages/**/page.tsx` files it dynamically imports, dead admin analytics (incl. the 2,529-line `arr-simulator`), `src/features/marketing/**`, `src/hooks/kortix/**`, `src/hooks/legacy/**`.

**Files:**
- Delete: the files listed by the report extraction below (~224 files under `src/`, `playground/`), in batches.

**Interfaces:**
- Consumes: nothing.
- Produces: a smaller diagnostic surface (later tasks skip fixes in deleted files — notably 3 `effect-needs-cleanup` errors in `src/components/tabs/*-tab-content.tsx` disappear here instead of being fixed in Task 6).

- [ ] **Step 1: Regenerate the dead-file list from a fresh scan**

Do not reuse a stale report — regenerate:

```bash
cd apps/web
npx react-doctor@latest --json --json-out /tmp/rd-report.json
python3 - <<'EOF'
import json
d = json.load(open('/tmp/rd-report.json'))
files = sorted(x['normalizedFilePath'] for x in d['diagnostics'] if x['rule'] == 'unused-file')
skip = {'src/lib/empty-module.ts', 'test-setup.ts'}
files = [f for f in files if f not in skip]
open('/tmp/dead-files.txt', 'w').write('\n'.join(files))
print(len(files), 'files to delete')
EOF
```

- [ ] **Step 2: Validate each file per the canonical deslop/unused-file recipe**

Canonical validation (deslop resolves only string-literal imports): a flagged file is a FALSE positive only if it is reached via a computed/template dynamic import, is a config-referenced entry, or is a side-effect-only module. Sweep for those patterns once:

```bash
cd apps/web
rg -n "import\(\s*[^'\"]|require\(\s*[^'\"]" src next.config.ts | rg -v "^\s*//" | head -30
```

For each hit that could resolve to a flagged file, remove that file from `/tmp/dead-files.txt`. (The audit already found exactly two config-referenced cases, both excluded above.)

- [ ] **Step 3: Delete in batches by top-level directory, verifying between batches**

Batch order (per-directory counts from the audit: components 140, features 32, hooks 28, lib 17, stores 4, app 1, types 1, playground 2, root 1):

```bash
cd apps/web
for prefix in src/components/tabs src/components/pages src/components/ui src/components/kortix src/components/home src/components/admin src/components/sidebar src/components features src/hooks src/lib src/stores src/app src/types playground; do
  grep "^$prefix" /tmp/dead-files.txt | xargs -r git rm -q
  # after EACH batch:
  npx tsc --noEmit || { echo "BATCH $prefix broke typecheck — investigate before continuing"; break; }
done
bun test --isolate
```

If a batch breaks typecheck: the break means a *live* file imported a deleted one — that importer is itself on the dead list (delete order artifact) or the file was a false positive. Restore just that file (`git checkout -- <file>`), note it, continue.

- [ ] **Step 4: Full verification**

```bash
cd apps/web && npx tsc --noEmit && bun test --isolate && pnpm build
npx react-doctor@latest --score
```

Expected: build passes; score improves materially (unused-file + the 239 `unused-export` warnings largely clear together since most dead exports live in dead files).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(web): delete ~224 dead files unreachable from app-router entry points (tabs subsystem, dead admin analytics, legacy hooks, marketing leftovers)"
```

---

### Task 3: Stop per-token re-renders of the session chat input subtree

**The single highest-leverage perf fix.** `SessionChat` (`src/features/session/session-chat.tsx`, 5,381 lines) re-renders on every streaming token. It renders `<SessionChatInput>` (2,483 lines, NOT memoized) with inline-created props — a fresh `onSend` async closure, a fresh `prefill` object, fresh `onAgentChange`/`onModelChange`/`modelDefaultControls` — so the entire input subtree re-renders per token. Additionally `SessionChat` subscribes to the whole `useKortixComputerStore` (line 3423) and five tool renderers subscribe to the whole `useFilePreviewStore`, causing re-renders on unrelated store changes.

**Files:**
- Modify: `apps/web/src/features/session/session-chat.tsx:3423` (store selector), `:5261` area (SessionChatInput props)
- Modify: `apps/web/src/features/session/session-chat-input.tsx` (memo wrap)
- Modify: `apps/web/src/features/session/tool-renderers.tsx:2031,2844,2899,2967,3154` (store selectors)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `SessionChatInput` becomes `React.memo`-wrapped; its props contract is unchanged.

- [ ] **Step 1: Replace the whole-store subscription in session-chat.tsx**

Current code at `src/features/session/session-chat.tsx:3423`:

```tsx
const { isSidePanelOpen, setIsSidePanelOpen, openFileInComputer } = useKortixComputerStore();
```

Replace with per-field selectors (the very next line already models this correctly with `useFilePreviewStore((s) => s.openPreview)`):

```tsx
const isSidePanelOpen = useKortixComputerStore((s) => s.isSidePanelOpen);
const setIsSidePanelOpen = useKortixComputerStore((s) => s.setIsSidePanelOpen);
const openFileInComputer = useKortixComputerStore((s) => s.openFileInComputer);
```

- [ ] **Step 2: Replace the five whole-store subscriptions in tool-renderers.tsx**

At each of lines 2031, 2844, 2899, 2967, 3154 the current code is:

```tsx
const { openPreview } = useFilePreviewStore();
```

Replace each with:

```tsx
const openPreview = useFilePreviewStore((s) => s.openPreview);
```

- [ ] **Step 3: Stabilize the inline props passed to SessionChatInput**

In `src/features/session/session-chat.tsx` (JSX around line 5261), the current code:

```tsx
<SessionChatInput
  onSend={async (text, files, mentions) => {
    await handleSend(text, files, mentions);
    if (failedStartDraft) {
      clearStartStash(sessionId);
      usePendingFilesStore.getState().consumePendingFiles();
      setFailedStartDraft(null);
    }
  }}
  prefill={
    failedStartDraft
      ? {
          text: failedStartDraft.text,
          files: failedStartDraft.files,
          id: failedStartDraft.id,
          mode: 'merge',
        }
      : null
  }
  ...
  onAgentChange={lockedAgentName ? undefined : (name) => local.agent.set(name ?? undefined)}
```

Hoist the closures/objects above the `return` (alongside the component's other `useCallback`s, e.g. near `handleSelectionReply` at ~line 3415):

```tsx
const handleSendWithDraftClear = useCallback(
  async (text: string, files: File[], mentions: SessionMention[]) => {
    await handleSend(text, files, mentions);
    if (failedStartDraft) {
      clearStartStash(sessionId);
      usePendingFilesStore.getState().consumePendingFiles();
      setFailedStartDraft(null);
    }
  },
  [handleSend, failedStartDraft, sessionId],
);

const chatPrefill = useMemo(
  () =>
    failedStartDraft
      ? {
          text: failedStartDraft.text,
          files: failedStartDraft.files,
          id: failedStartDraft.id,
          mode: 'merge' as const,
        }
      : null,
  [failedStartDraft],
);

const handleAgentChange = useCallback(
  (name: string | null) => local.agent.set(name ?? undefined),
  [local.agent],
);
```

Then in the JSX: `onSend={handleSendWithDraftClear}`, `prefill={chatPrefill}`, `onAgentChange={lockedAgentName ? undefined : handleAgentChange}`. Apply the identical hoist pattern to the remaining inline props on this JSX element (`onModelChange`, `modelDefaultControls`, and any other inline arrow/object literal props on `<SessionChatInput>`): move each body verbatim into a `useCallback`/`useMemo` above the return, with the dependency array containing exactly the identifiers the body references (let `exhaustive-deps` lint confirm). The parameter types come from `SessionChatInput`'s existing props interface in `session-chat-input.tsx` — import/reuse, do not redeclare.

- [ ] **Step 4: Wrap SessionChatInput in React.memo**

In `src/features/session/session-chat-input.tsx`, the component is exported as a plain `export function SessionChatInput(...)`. Convert to:

```tsx
function SessionChatInputImpl(props: SessionChatInputProps) {
  // ...existing body unchanged...
}
export const SessionChatInput = memo(SessionChatInputImpl);
```

(add `import { memo } from 'react';` to the existing react import). If the props interface is currently inlined in the function signature, extract it to a named `SessionChatInputProps` type first. Keep the export name identical so no import sites change.

- [ ] **Step 5: Verify behaviorally**

Run the app (worktree dev stack) and in React DevTools enable "Highlight updates while components render". Start a streaming session response and confirm: the chat input toolbar no longer flashes on every token; typing in the input stays responsive during streaming; sending a message, switching agent, and the failed-start-draft prefill flow all still work.

- [ ] **Step 6: Verification gate + commit**

```bash
cd apps/web && npx tsc --noEmit && bun test --isolate && npx react-doctor@latest --verbose --scope changed
git add src/features/session/session-chat.tsx src/features/session/session-chat-input.tsx src/features/session/tool-renderers.tsx
git commit -m "perf(web): stop per-token re-renders of chat input subtree (memo + stable props + store selectors)"
```

---

### Task 4: Error boundary around SessionChat

A throw anywhere in the streaming/message-grouping hot path currently crashes the whole session route: `src/app/(app)/projects/[id]/sessions/[sessionId]/page.tsx:625` renders `<SessionChat>` bare inside `SessionLayout`, which renders `{children}` with no boundary (`session-layout.tsx:369`). The repo already has `ClientErrorBoundary` (`src/components/common/error-boundary.tsx:95`) with a Sentry-reporting default fallback.

**Files:**
- Modify: `apps/web/src/app/(app)/projects/[id]/sessions/[sessionId]/page.tsx:625`

**Interfaces:**
- Consumes: `ClientErrorBoundary` from `@/components/common/error-boundary` (existing).
- Produces: nothing later tasks rely on.

- [ ] **Step 1: Wrap SessionChat**

Current code (page.tsx ~618-627):

```tsx
return (
  <SessionLayout
    key={chatSessionId}
    sessionId={chatSessionId}
    projectId={projectId}
    projectSessionId={sessionId}
  >
    <SessionChat key={chatSessionId} sessionId={chatSessionId} projectId={projectId} />
  </SessionLayout>
);
```

New code:

```tsx
return (
  <SessionLayout
    key={chatSessionId}
    sessionId={chatSessionId}
    projectId={projectId}
    projectSessionId={sessionId}
  >
    <ClientErrorBoundary>
      <SessionChat key={chatSessionId} sessionId={chatSessionId} projectId={projectId} />
    </ClientErrorBoundary>
  </SessionLayout>
);
```

with `import { ClientErrorBoundary } from '@/components/common/error-boundary';` added to the imports. Check `ClientErrorBoundary`'s props signature at `error-boundary.tsx:95` first — if it requires a `fallback` prop (not optional), pass nothing extra only if it has the `DefaultAppFallback` default; otherwise pass no override so the default Sentry-reporting fallback renders.

- [ ] **Step 2: Verify behaviorally**

Temporarily add `throw new Error('boundary test')` at the top of `SessionChat`'s body, load a session route, and confirm the "Something went wrong / Try again" fallback renders inside the session layout (sidebar still alive) instead of the route crashing. Remove the test throw.

- [ ] **Step 3: Verification gate + commit**

```bash
cd apps/web && npx tsc --noEmit && bun test --isolate && npx react-doctor@latest --verbose --scope changed
git add 'src/app/(app)/projects/[id]/sessions/[sessionId]/page.tsx'
git commit -m "fix(web): wrap SessionChat in error boundary so streaming crashes don't kill the session route"
```

---

### Task 5: Fix render-phase blob URL side effects in SandboxImage

`react-doctor/no-ref-current-in-render` (error) at `src/features/session/sandbox-image.tsx:61,69`: blob URLs are created AND revoked inside a `useMemo` — a render-phase side effect. Under StrictMode/concurrent rendering React can replay or discard renders, revoking an in-use blob URL (broken image) or leaking one. Canonical recipe: "Move ref writes into an event handler or effect."

**Files:**
- Modify: `apps/web/src/features/session/sandbox-image.tsx:55-102`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing later tasks rely on.

- [ ] **Step 1: Replace the useMemo + ref + unmount-effect with a single effect owning the URL lifecycle**

Current code (lines 55-83):

```tsx
// Convert base64 to blob URL (same pattern as tool-renderers.tsx)
const blobUrlRef = useRef<string | null>(null);
const blobUrl = useMemo(() => {
	// Revoke previous blob URL when data changes
	if (blobUrlRef.current) {
		URL.revokeObjectURL(blobUrlRef.current);
		blobUrlRef.current = null;
	}
	if (fileContentData?.encoding === 'base64' && fileContentData?.content) {
		const binary = atob(fileContentData.content);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		const blob = new Blob([bytes], { type: fileContentData.mimeType || 'image/png' });
		const url = URL.createObjectURL(blob);
		blobUrlRef.current = url;
		return url;
	}
	return null;
}, [fileContentData]);

// Cleanup blob URL on unmount
useEffect(() => {
	return () => {
		if (blobUrlRef.current) {
			URL.revokeObjectURL(blobUrlRef.current);
			blobUrlRef.current = null;
		}
	};
}, []);
```

New code (state + one effect; the effect's cleanup handles both data-change and unmount):

```tsx
const [blobUrl, setBlobUrl] = useState<string | null>(null);
const hasBase64 = fileContentData?.encoding === 'base64' && !!fileContentData?.content;
useEffect(() => {
	if (!(fileContentData?.encoding === 'base64' && fileContentData.content)) {
		setBlobUrl(null);
		return;
	}
	const binary = atob(fileContentData.content);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	const blob = new Blob([bytes], { type: fileContentData.mimeType || 'image/png' });
	const url = URL.createObjectURL(blob);
	setBlobUrl(url);
	return () => {
		URL.revokeObjectURL(url);
	};
}, [fileContentData]);
```

Update the imports line (`useEffect, useMemo, useRef` → keep only what remains used: `useEffect, useMemo, useState`; `useMemo` is still used by `fileContentPath` at line 45).

- [ ] **Step 2: Prevent a one-frame "Image unavailable" flash**

Because the blob URL now materializes one effect-pass after data arrives, extend the loading condition (line 89) so the skeleton also covers that gap. Current:

```tsx
if (isLocalPath && isLoading) {
```

New:

```tsx
if (isLocalPath && (isLoading || (hasBase64 && !blobUrl))) {
```

- [ ] **Step 3: Verify behaviorally**

In a session where the agent produced an image under `/workspace/`, confirm the image renders, and re-renders correctly when the underlying file content refetches. No broken-image flicker.

- [ ] **Step 4: Verification gate + commit**

```bash
cd apps/web && npx tsc --noEmit && bun test --isolate && npx react-doctor@latest --verbose --scope changed
git add src/features/session/sandbox-image.tsx
git commit -m "fix(web): move SandboxImage blob URL lifecycle out of render into an effect"
```

---

### Task 6: Purify state updaters and fix confirmed effect-cleanup leaks

Two error-severity correctness sweeps with mechanical, canonical fixes.

**A. `no-impure-state-updater` (15 sites).** Canonical recipe: "Keep state updater callbacks pure and return only the next state. Move notifications, storage, timers, ref writes, and other external work into the event or effect that queues the update."

**B. `effect-needs-cleanup` (24 errors, minus 3 vetted false positives and 3 in files deleted by Task 2).** Canonical recipe patterns: (A) sync timers → capture id, `return () => clearTimeout(id)`; (B) listeners → named handler, remove same reference; (C) subscribe-returning APIs → `return () => sub.unsubscribe()`; (D) resource set inside async/observer callback → mutable local id cleared from one returned teardown.

**Files (A — impure updaters):**
- Modify: `src/features/session/session-actions-panel.tsx:99`
- Modify: `src/components/file-renderers/image-renderer.tsx:145,157`
- Modify: `src/features/files/components/file-search.tsx:78,86` and `src/features/project-files/components/file-search.tsx:78,86` (identical twins — apply the same diff to both)
- Modify: `src/features/layout/user-menu.tsx:115,120,228,233`, `src/features/layout/account-switcher.tsx:223`, `src/components/changelog/version-history-panel.tsx:246`, `src/features/auth/phone-verification/otp-verification.tsx:50`, `src/components/ui/extend/pdf-viewer.tsx:1954`

**Files (B — effect cleanup):**
- Modify: `src/app/(app)/checkout/page.tsx:55`, `src/app/(auth)/auth/github-connect/page.tsx:21`, `src/app/(auth)/auth/github-popup/page.tsx:24`, `src/app/(public)/(marketing)/support/page.tsx:42`, `src/app/(public)/templates/[shareId]/page.tsx:132`, `src/components/kortix/markdown-field.tsx:93`, `src/components/kortix/new-task-dialog.tsx:79`, `src/components/kortix/new-ticket-dialog.tsx:367,505`, `src/components/kortix/project-about.tsx:71`, `src/components/kortix/ticket-detail-drawer.tsx:340`, `src/components/onboarding/boot-overlay.tsx:58`, `src/components/ui/animated-bg.tsx:304`, `src/components/ui/globe.tsx:98`, `src/components/ui/mermaid-renderer.tsx:296`, `src/hooks/platform/use-sandbox-poller.ts:352` (EventSource), `src/hooks/tunnel/use-tunnel-realtime.ts:18`, `src/hooks/use-debounced-busy-sessions.ts:46`

**Do NOT touch (vetted false positives):** `sandbox-url-detector.tsx:123`, `session-chat.tsx:4160`, `file-content-renderer.tsx:407` (all have working cleanups the matcher missed); `session-starting-loader.tsx:109-110` (sanctioned prev-value render pattern). Skip `src/components/tabs/*-tab-content.tsx` — deleted in Task 2.

**Interfaces:**
- Consumes: Task 2 deletions (skip list above).
- Produces: nothing later tasks rely on.

- [ ] **Step 1: Fix the worked example — session-actions-panel.tsx:99**

Current code:

```tsx
const goNext = useCallback(() => {
  setIndex((i) => {
    const next = Math.min(count - 1, i + 1);
    setMode(next >= count - 1 ? 'live' : 'manual');
    return next;
  });
}, [count]);
```

New code (nested setState moved out of the updater into the handler; `index` must come from the store/state the component already reads — reuse the existing `index` state variable):

```tsx
const goNext = useCallback(() => {
  const next = Math.min(count - 1, index + 1);
  setMode(next >= count - 1 ? 'live' : 'manual');
  setIndex(next);
}, [count, index]);
```

- [ ] **Step 2: Fix the second worked example — image-renderer.tsx:145 (same shape at 157)**

Current pattern:

```tsx
setZoom((prev) => {
  const newZoom = /* ...existing math... */;
  if (newZoom <= 0.5) setIsFitToScreen(true);
  return newZoom;
});
```

New pattern — compute first, then queue both updates from the handler:

```tsx
const newZoom = /* same math, using the current zoom value available in the handler */;
if (newZoom <= 0.5) setIsFitToScreen(true);
setZoom(newZoom);
```

Where the current value isn't available in the handler (wheel events), read it via the functional form ONCE into a computation done in the handler scope — never call another `set*` inside an updater.

- [ ] **Step 3: Fix file-search twins (78, 86 in both trees)**

Current pattern (both files identical):

```tsx
setSelectedIndex((prev) => {
  const next = /* ... */;
  requestAnimationFrame(() => scrollItemIntoView(next));
  return next;
});
```

New pattern:

```tsx
const next = /* same computation, from the current selectedIndex in handler scope */;
setSelectedIndex(next);
requestAnimationFrame(() => scrollItemIntoView(next));
```

Apply the byte-same diff to `src/features/files/components/file-search.tsx` and `src/features/project-files/components/file-search.tsx`.

- [ ] **Step 4: Validate-then-fix the remaining A sites**

For each remaining site (`user-menu.tsx:115,120,228,233`, `account-switcher.tsx:223`, `version-history-panel.tsx:246`, `otp-verification.tsx:50`, `pdf-viewer.tsx:1954`): read the flagged line. CONFIRM only if a `set*` call, timer, storage write, or ref write executes **inside a state-updater callback** (`setX((prev) => { ...side effect... })`). If the side effect is merely in the same event handler (not inside the updater fn), mark it NOISE in the commit message and leave the code alone. For confirmed sites apply the Step-1/2/3 shape: hoist the side effect out of the updater into the handler, keep the updater pure.

- [ ] **Step 5: Fix the B sites with the matching canonical pattern**

For each B file: open the flagged effect, identify what it registers, and apply exactly one pattern:

Pattern A (majority — bare `setTimeout` in effect body), e.g. `boot-overlay.tsx:58`:

```tsx
useEffect(() => {
  const id = setTimeout(() => { /* existing callback body unchanged */ }, DELAY);
  return () => clearTimeout(id);
}, [/* existing deps unchanged */]);
```

Pattern B (`addEventListener` — `globe.tsx:98`, `animated-bg.tsx:304`, `use-tunnel-realtime.ts:18`):

```tsx
useEffect(() => {
  const handler = /* existing inline handler, hoisted to a const */;
  target.addEventListener('event', handler);
  return () => target.removeEventListener('event', handler);
}, [/* deps */]);
```

Pattern C (`.on(...)` subscriptions — `templates/[shareId]/page.tsx:132`): if the emitter exposes `.off`/`.unsubscribe`, return it with the same handler reference.

Pattern D (resource created in an async flow — `checkout/page.tsx:55` where `setTimeout` runs inside async `initCheckout`, and `use-sandbox-poller.ts:352` where an `EventSource` is opened in a function that outlives the render):

```tsx
useEffect(() => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const run = async () => {
    /* existing async body; every `setTimeout(...)` assigns to `timer`;
       after each `await`, bail early with `if (disposed) return;` */
  };
  run();
  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    /* for use-sandbox-poller: also close the EventSource instance here —
       store it in a local `let es: EventSource | null` the same way */
  };
}, [/* existing deps */]);
```

Per the canonical anti-patterns: never delete the timer/listener to silence the rule, never `return () => {}` as a no-op, and if a flagged registration turns out to be defined-and-handed-off (not executed by the effect itself), skip it and note it.

- [ ] **Step 6: Verification gate + commit**

```bash
cd apps/web && npx tsc --noEmit && bun test --isolate && npx react-doctor@latest --verbose --scope changed
```

Expected: zero remaining `no-impure-state-updater` and `effect-needs-cleanup` errors outside the documented skip list.

```bash
git add -A
git commit -m "fix(web): purify state updaters and add effect cleanups for timers/listeners/EventSource"
```

---

### Task 7: Accessibility on the session hot path

The 200 a11y warnings concentrate in the session UI — the most-used surface. Vetted clusters: the **main chat textarea has no accessible name** (`placeholder=""`, no aria-label), icon-only toolbar buttons have only visual tooltips, and mention chips / tool-renderer controls are `<span onClick>` with no keyboard path. Canonical recipes: `control-has-associated-label` → "for an icon-only control add aria-label"; `no-static-element-interactions` → "use a native semantic element — they ship with role, focus, and keyboard support" or add `role` + `tabIndex={0}` + key handlers.

**Files:**
- Modify: `src/features/session/session-chat-input.tsx:718,2288,2327`
- Modify: `src/features/session/session-chat.tsx:497,508,1601,1677,1688` (mention chips)
- Modify: `src/features/session/tool-renderers.tsx:406,418,5219,5231,7222` (labels) and `:1074,1180,3053,3331,3355,6728` (static-element clicks)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing later tasks rely on.

- [ ] **Step 1: Name the chat textarea (session-chat-input.tsx:2288)**

The `<textarea ref={textareaRef} ... placeholder="" rows={1}` element gets:

```tsx
aria-label="Message input"
```

- [ ] **Step 2: Name the icon-only buttons**

Attach button at `:2327` (the `<button type="button" onClick={() => fileInputRef.current?.click()}` wrapping `<Paperclip>`):

```tsx
aria-label="Attach files"
```

Attachment remove button at `:718` (the `<button onClick={() => onRemove(i)}>` wrapping `<X>` — note it also lacks `type`):

```tsx
type="button"
aria-label={`Remove ${name}`}
```

Then the tool-renderers label sites (`406, 418, 5219, 5231, 7222`): read each control, add an `aria-label` naming its action (e.g. "Copy output", "Open file") — derive the wording from the adjacent `Tooltip`/`TooltipContent` text so the SR name matches the visual tooltip.

- [ ] **Step 3: Make mention chips keyboard-operable (session-chat.tsx:497,508,1601,1677,1688)**

Current pattern (file-mention chip at 497):

```tsx
<span
  key={i}
  className={mentionClass}
  onClick={(e) => {
    e.stopPropagation();
    onFileClick(seg.text.replace(/^@/, ''));
  }}
>
  {seg.text}
</span>
```

These are interaction targets (they open files/sessions), so per the canonical recipe make them semantic buttons; the existing `mentionClass` underline styling carries over:

```tsx
<button
  key={i}
  type="button"
  className={cn(mentionClass, 'appearance-none bg-transparent p-0 text-left')}
  onClick={(e) => {
    e.stopPropagation();
    onFileClick(seg.text.replace(/^@/, ''));
  }}
>
  {seg.text}
</button>
```

Apply the same span→button conversion at all five sites (the session-mention variants keep their existing onClick bodies verbatim). If a site sits inside a `<p>`/inline-only context where a `<button>` breaks layout, use the div-fallback from the canonical recipe instead: keep the `<span>` and add `role="button"` + `tabIndex={0}` + an `onKeyDown` that triggers the same handler on `Enter`/`' '`.

- [ ] **Step 4: Fix the tool-renderers static-element clicks (1074, 1180, 3053, 3331, 3355, 6728)**

For each `<div|span onClick>`: decide per the canonical validation — if it's a genuine interaction target, convert to `<button type="button">` (preferred) or add `role="button" tabIndex={0}` + Enter/Space `onKeyDown`; if it's a wrapper only catching bubbled events from interactive children, leave it and record it as noise in the commit message.

- [ ] **Step 5: Verify behaviorally**

Keyboard-only pass: Tab through the chat input area — textarea, attach button, a rendered mention chip, a tool-renderer control — confirm each is reachable and activates with Enter/Space. VoiceOver (or the a11y tree in devtools) announces "Message input", "Attach files", "Remove <filename>".

- [ ] **Step 6: Verification gate + commit**

```bash
cd apps/web && npx tsc --noEmit && bun test --isolate && npx react-doctor@latest --verbose --scope changed
git add src/features/session/session-chat-input.tsx src/features/session/session-chat.tsx src/features/session/tool-renderers.tsx
git commit -m "fix(web): accessible names + keyboard operability for session chat controls"
```

---

### Task 8: Consolidate duplicated utility functions

Truffler + ripgrep sweep found (all confirmed by reading implementations): ~15 relative-time formatters, ~16 `formatDate` wrappers, 7 `copyToClipboard`, byte-identical `downloadBlob` ×2 and `useDebounce` ×2, `truncate` ×4, `isImageFile` ×2, `getLanguageFromExtension` ×2. **Deliberately skipped:** the 5-way `slugify` family (same-intent-but-different-output; slugs may be persisted as keys — consolidating could change stored identifiers) and `debounce` fns in `game-of-life`/`rauch` demos (cold toys).

**Files:**
- Create: `src/lib/utils/date.ts`, `src/lib/utils/date.test.ts`
- Create: `src/lib/utils/clipboard.ts`
- Create: `src/lib/utils/download.ts`
- Create: `src/hooks/use-debounce.ts`
- Create: `src/lib/utils/string.ts`, `src/lib/utils/string.test.ts`
- Modify: `src/lib/utils/file-utils.ts` (+`file-utils.test.ts`) — add `isImageFile`
- Modify: `src/components/file-editors/utils.ts` — absorb superset `getLanguageFromExtension`
- Modify: the call sites listed per step.

**Interfaces:**
- Consumes: nothing.
- Produces: `relativeTime(t?: string|number|null): string`, `fullDate(t?: string|null): string`, `formatDate(t?): string`, `formatDateTime(t?): string`, `copyToClipboard(text: string): Promise<boolean>`, `downloadBlob(blob: Blob, filename: string): void`, `useDebounce<T>(value: T, delayMs?: number): T`, `truncate(text: string, max: number): string`, `isImageFile(file: File): boolean`.

- [ ] **Step 1: Write failing tests for the date helpers**

`src/lib/utils/date.test.ts` (repo convention: co-located `bun:test`, no comments):

```ts
import { describe, expect, it } from 'bun:test';
import { formatDate, formatDateTime, relativeTime } from './date';

describe('date utils', () => {
  it('formats a date as short month/day/year', () => {
    expect(formatDate('2026-07-04T12:00:00Z')).toBe('Jul 4, 2026');
  });
  it('returns empty string for nullish input', () => {
    expect(formatDate(null)).toBe('');
    expect(formatDateTime(undefined)).toBe('');
    expect(relativeTime(null)).toBe('');
  });
  it('formats recent timestamps relatively', () => {
    expect(relativeTime(Date.now() - 30_000)).toBe('just now');
    expect(relativeTime(Date.now() - 5 * 60_000)).toBe('5m ago');
  });
});
```

Run: `bun test src/lib/utils/date.test.ts` → Expected: FAIL (module not found).

- [ ] **Step 2: Create `src/lib/utils/date.ts`**

`relativeTime`/`fullDate` already exist in `src/lib/kortix/task-meta.ts:110/123` — re-export them as the canonical import path and add the two missing wrappers:

```ts
export { fullDate, relativeTime } from '@/lib/kortix/task-meta';

export function formatDate(t?: string | number | Date | null): string {
  if (!t) return '';
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatDateTime(t?: string | number | Date | null): string {
  if (!t) return '';
  return new Date(t).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
```

Run: `bun test src/lib/utils/date.test.ts` → Expected: PASS (timezone note: if the `Jul 4, 2026` assertion is flaky across TZ, pin with a midday UTC timestamp as shown).

- [ ] **Step 3: Migrate the date call sites**

Relative-time locals to delete + replace with `import { relativeTime } from '@/lib/utils/date'`: `src/components/iam/scim-card.tsx:49`, `src/components/iam/service-accounts-card.tsx:393`, `src/components/iam/session-controls-card.tsx:349`, `src/features/session/session-audit-shared.tsx:171`, `src/components/projects/schedule-view.tsx:178`, `src/components/scheduled-tasks/scheduled-tasks-page.tsx:91`, `src/components/kortix/triggers-tab.tsx:53`, `src/components/kortix/ticket-board.tsx:99`, `src/features/accounts/settings/cli-tokens-tab.tsx:38`, `src/app/admin/accounts/page.tsx:1494`.

`formatDate`-family locals to delete + replace with the matching `formatDate`/`formatDateTime` import: `src/features/billing/billing-history.tsx:38`, `src/components/admin/admin-user-table.tsx:64`, `src/components/admin/admin-user-details-dialog.tsx:100`, `src/components/admin/admin-feedback-table.tsx:38`, `src/components/admin/admin-dashboard-sections.tsx:117`, `src/app/(app)/accounts/[id]/page.tsx:198`, `src/app/(app)/accounts/[id]/members/[userId]/page.tsx:48`, `src/app/admin/ops/page.tsx:298`, `src/app/admin/accounts/page.tsx:196`, `src/features/billing/credit-transactions.tsx:42`, `src/features/accounts/settings/general-tab.tsx:208`.

Rule for each site: read the local implementation first. Replace ONLY if the local output format matches the shared helper exactly (same locale options ladder / same unit cutoffs). If a site intentionally differs (different fields, added seconds, different fallback), leave it and note it. Files deleted by Task 2 will already be gone — skip them.

- [ ] **Step 4: Clipboard, download, debounce, truncate, isImageFile, language-map**

`src/lib/utils/clipboard.ts`:

```ts
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
```

Migrate the byte-identical iam trio (`scim-card.tsx:64`, `sso-card.tsx:54`, `audit-webhooks-card.tsx:59`) plus `schedule-view.tsx:227`, `referral-code-section.tsx:23`, `use-referrals.ts:74`: each keeps its own toast, calling `if (await copyToClipboard(v)) toast.success(...)`. Leave `code-block/index.tsx:450` (vendored shadcn-io component — keep vendored code pristine).

`src/lib/utils/download.ts`: lift the implementation **verbatim** from `src/components/ui/extend/pdf-viewer.tsx:265` (it is byte-identical to `docx-viewer.tsx:169`), export as `downloadBlob(blob: Blob, filename: string): void`; replace both local copies with the import.

`src/hooks/use-debounce.ts`: lift the `useDebounce` hook **verbatim** from `src/app/admin/accounts/page.tsx:113` (byte-identical to `admin-dashboard-sections.tsx:128` bar a default arg — keep the default arg variant); replace both locals.

`src/lib/utils/string.ts` + test:

```ts
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
```

```ts
import { describe, expect, it } from 'bun:test';
import { truncate } from './string';

describe('truncate', () => {
  it('passes through short strings', () => {
    expect(truncate('abc', 5)).toBe('abc');
  });
  it('truncates long strings with ellipsis', () => {
    expect(truncate('abcdef', 3)).toBe('abc…');
  });
});
```

Before migrating `chat-minimap.tsx:32`, `tool-meta.ts:55`, `system-fault.tsx:25`, `milestone-dialog.tsx:487`: check each local's slice boundary (`max` vs `max - 1`) and match the shared helper to the dominant convention, adjusting the test to that exact behavior. `tool-meta.ts` also collapses whitespace — keep its wrapper, calling the shared `truncate` inside.

`isImageFile`: move the **superset** version from `src/features/session/session-chat-input.tsx:531` (MIME check + ext allow-list incl. ico/heic/heif) into `src/lib/utils/file-utils.ts`, add a test case to `file-utils.test.ts` (`expect(isImageFile(new File([], 'a.heic', { type: '' }))).toBe(true)`), and import it at `session-chat-input.tsx` and `new-task-dialog.tsx:27`.

`getLanguageFromExtension`: replace the body in `src/components/file-editors/utils.ts:46` with the **superset** implementation from `code-editor.tsx:182` (adds filename detection), delete the local in `code-editor.tsx`, import from `./utils`.

- [ ] **Step 5: Verification gate + commit**

```bash
cd apps/web && npx tsc --noEmit && bun test --isolate && npx react-doctor@latest --verbose --scope changed
git add -A
git commit -m "refactor(web): consolidate duplicated date/clipboard/download/debounce/truncate/file helpers into shared utils"
```

---

### Task 9: Merge the doc-markdown / unified-markdown twins

`src/components/markdown/doc-markdown.tsx` (752 lines) and `src/components/markdown/unified-markdown.tsx` (755 lines) are **97.5% identical** — two ~750-line near-clones that must be edited twice today (both are flagged at the same line numbers by react-doctor).

**Files:**
- Modify: `src/components/markdown/unified-markdown.tsx` (becomes the single implementation)
- Modify: `src/components/markdown/doc-markdown.tsx` (becomes a thin wrapper)

**Interfaces:**
- Consumes: nothing.
- Produces: `DocMarkdown` keeps its exact current props/export so no import sites change.

- [ ] **Step 1: Enumerate the real delta**

```bash
cd apps/web/src/components/markdown
diff <(sed -E 's/[A-Za-z]+Markdown/XMarkdown/g' doc-markdown.tsx) \
     <(sed -E 's/[A-Za-z]+Markdown/XMarkdown/g' unified-markdown.tsx) | head -80
```

Record every non-cosmetic difference (expected: a handful of prop defaults / class names — the audit found the KaTeX and Shiki blocks byte-identical).

- [ ] **Step 2: Parameterize unified-markdown with the delta**

For each behavioral difference found in Step 1, add an optional prop to `UnifiedMarkdown`'s existing props type (e.g. `variant?: 'chat' | 'doc'` or a specific boolean per difference — choose the narrowest prop that expresses the actual delta, defaulting to current `UnifiedMarkdown` behavior so existing call sites are unaffected).

- [ ] **Step 3: Reduce doc-markdown.tsx to a wrapper**

```tsx
export function DocMarkdown(props: DocMarkdownProps) {
  return <UnifiedMarkdown {...props} variant="doc" />;
}
```

keeping `DocMarkdownProps` exported if it was before, mapped onto `UnifiedMarkdown`'s props. All ~750 duplicated lines in doc-markdown.tsx are deleted.

- [ ] **Step 4: Verify behaviorally**

Render both markdown surfaces: a chat session with agent markdown output (code fences with Shiki highlighting, a KaTeX math block, a mermaid diagram) and a docs/changelog surface that uses `DocMarkdown`. Compare against `main` visually — identical output.

- [ ] **Step 5: Verification gate + commit**

```bash
cd apps/web && npx tsc --noEmit && bun test --isolate && npx react-doctor@latest --verbose --scope changed
git add src/components/markdown/
git commit -m "refactor(web): collapse doc-markdown into a thin variant of unified-markdown (was 97.5% duplicated)"
```

---

## Explicitly deferred (needs its own plan / owner decision — do NOT attempt here)

1. **Merge `src/features/files/` and `src/features/project-files/`** — 34 same-named files; the presentational shell (11 files) is ≥90% identical but the data/api layer diverged (~63% weighted overall) and `project-files` carries 20 unique version-control files. This is a real feature-tree unification project, not a sweep.
2. **Split `session-chat.tsx` (5,381 lines) and `session-chat-input.tsx` (2,483)** — highest-maintainability leverage but demands domain decomposition; Task 3 fixes the perf symptom first.
3. **`requestAccess` server action hardening** (`src/app/(auth)/auth/actions.ts:222`) — intentionally public, but has no rate limiting and only `email.includes('@')` validation; the fix belongs in the backend `POST /access/request-access` (rate limit + validation), not the web tier.
4. **Layout-property animations** (20 errors) — the real ones worth doing are `ShareViewer.tsx:331-357`, `review-center.tsx:920-922`, `general-tab.tsx:404-406`, `permission-editor.tsx:97-99` (animate `transform`/`clip-path` instead of width/height). Vetted as cosmetic-noise: `switch.tsx:172-173` and `sliding-tab-indicator.tsx:102-103` (tiny layout areas). Follow the animations-dev skill when tackling.
5. **`no-adjust-state-on-prop-change` key-resets** (127 warnings; vetted-real at `session-layout.tsx:292,303`, `file-content-renderer.tsx:508-512`, `image-renderer.tsx:68-77`) — mechanical (`key={...}` resets) but each needs a remount-cost judgment.
6. **A11y long tail** (~150 remaining warnings on secondary surfaces: sandbox-url-detector, opencode-settings-dialog, marketing pages).

## Vetted false positives (never "fix" these)

| Location | Rule | Why it's noise |
| --- | --- | --- |
| `src/lib/supabase/server.ts:6` | server-auth-actions | Factory returning a non-serializable client, not a callable action |
| `src/app/layout.tsx:174,249,279` + SEO pages | unsafe-json-in-html | Build-time/static data (runtime env config, schema.org JSON-LD), not user-controlled |
| `src/middleware.ts:167` | clickjacking-redirect-risk | Redirect target is a hardcoded same-origin path |
| markdown/mermaid `dangerous-html-sink` | dangerous-html-sink | KaTeX `trust:false`, Shiki escapes, mermaid `securityLevel:'strict'`, rehype-sanitize runs in the streamdown pipeline |
| `sandbox-url-detector.tsx:123`, `session-chat.tsx:4160`, `file-content-renderer.tsx:407` | effect-needs-cleanup | Working cleanups exist; matcher missed them |
| `session-starting-loader.tsx:109-110` | no-ref-current-in-render | Sanctioned guarded prev-value pattern |
| `package.json` `@embedpdf/pdfium` | unused-dependency | Used by postinstall to ship `pdfium.wasm` |
| `src/lib/empty-module.ts`, `test-setup.ts` | unused-file | next.config webpack alias / bunfig test preload |
| `session-chat-input.tsx:1234-1240` | rerender-memo-with-default-value | Component wasn't memoized (until Task 3); default params were irrelevant |
