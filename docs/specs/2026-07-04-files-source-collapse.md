# Files / Project-Files source collapse

Status: Stage 1 landed (uncommitted, branch `sdk-wave4`). Stages 2-4 planned, not started.

## Why

`apps/web/src/features/files` (live-sandbox, read/write file browser over
`@kortix/sdk`'s OpenCode-server client) and `apps/web/src/features/project-files`
(read-only, git-ref-scoped "Drive" view over `@kortix/sdk`'s projects client)
are two independent React feature trees that render the same UI — a tree
sidebar, a grid/list "Drive" view, a file viewer, history panels, search —
over two different data backends. Before this change: `files/` was 9,947
lines, `project-files/` was 12,016 lines, and roughly half of the ~30 file
pairs between them were 89-100% textually identical. They are also actively
diverging by accident: PR #4094 touched 11 files that exist in both trees but
only edited the `project-files/` copies, because there is no shared layer to
force the change through once.

The fix is not "merge the two features" — they have a real behavioral
difference (one mutates a live sandbox, the other reads a frozen git ref and
knows about branches/commits/change-requests) — it's to stop hand-copying the
~50% of the UI that has no reason to differ, by extracting it behind a small
`FileSource`-shaped seam, the same pattern already used for `file-content-renderer.tsx`
/ `file-preview-modal.tsx` in `apps/web/src/features/file-viewer` (landed in
PR #4130, wave 3). This doc extends that pattern to the rest of the tree.

## Diff inventory (all ~36 file pairs + tree-only files)

Methodology: `diff -u` between the two trees' same-named file, `diffLines /
(lines_a + lines_b)` as a rough textual-identity percentage. "Dependency
blocker" = the divergent sibling module(s) a file would need injected before
it can move to a shared location without behavior change.

### Zero-dependency (pure logic/types/state, no divergent sibling) — Stage 1, DONE

| Pair | files/ lines | project-files/ lines | Identity | Status |
|---|---|---|---|---|
| `types.ts` | 150 | 150 | 100% (byte-identical) | Moved → `file-browser/types.ts` |
| `store/files-store.ts` (+`.test.ts`) | 485 | 485 | 100% (1-line: an `export` keyword) | Moved → `file-browser/store/files-store.ts` |
| `search/workspace-search-core.ts` (+`.test.mts`) | 271 | 271 | 100% (byte-identical) | Moved → `file-browser/search/workspace-search-core.ts` |
| `hooks/use-file-events.ts` | 15 | 15 | 100% (byte-identical) | Moved → `file-browser/hooks/use-file-events.ts` |

These had zero imports from any divergent sibling (no SDK client, no
`file-icon`, no per-tree hook) — pure UI state / pure functions / types. Moved
verbatim, no parameterization needed.

### Near-identical, ONE prop-injectable dependency — Stage 1, DONE

| Pair | files/ lines | project-files/ lines | Identity | Real diff | Status |
|---|---|---|---|---|---|
| `components/file-tree-item.tsx` | 379 | 379 | ~98% | (a) `getFileIcon` import (divergent per-tree icon set) (b) one label: "View History" vs "Checkpoint history"; i18n key namespace differs (cosmetic — `tHardcodedUi` keys are opaque strings, not derived from file path, so both trees' existing key strings keep resolving unchanged after the move — confirmed no codegen/lint ties a key to its calling file's path) | Moved → `file-browser/components/file-tree-item.tsx`, `getIcon: FileIconResolver` made a required prop, `historyLabel?: string` optional prop (defaults to the `files/` "View History" copy; `project-files/file-browser.tsx` passes its "Checkpoint history" string via its own existing translation key) |

This is the template for every other component below: identify the one or
two things that actually differ (an icon resolver, a callback, a label), pass
them as props instead of importing a divergent sibling.

### Near-identical, but blocked on a hooks/data seam — Stage 2 (not started)

All of these are otherwise-identical presentational components whose only
blocker is that they `import { X } from '../hooks'` or `'../store/...'` for a
hook that has the **same name and shape** in both trees but a **different
implementation** underneath (different SDK client). They cannot move to a
shared file today because a shared file can't do `from '../hooks'` — there is
no single `../hooks` once the file lives outside both trees.

| Pair | files/ | project-files/ | Identity | Dependency blocker |
|---|---|---|---|---|
| `components/file-viewer.tsx` | 37 | 37 | 100% | `./file-content-renderer` (already source-adapted per tree, per wave 3) |
| `components/file-explorer-status-bar.tsx` | 98 | 98 | 100% | `useGitStatus`, `useServerHealth`, `useCurrentProject` (`../hooks`) |
| `components/file-breadcrumbs.tsx` | 293 | 293 | 100% | `getFileIcon` (`./file-icon`) |
| `components/file-explorer-toolbar.tsx` | 108 | 108 | ~100% (i18n key only) | `useCurrentProject`, `useInvalidateFileList` (`../hooks`), `getFileIcon` |
| `components/file-history-panel.tsx` | 432 | 429 | 98% | `useFileHistory`, `useFileCommitDiff` (`../hooks/use-file-history`) |
| `components/file-history-popover.tsx` | 253 | 249 | 95% | same as above |
| `components/file-search.tsx` | 188 | 190 | 98% | `useFileSearch` (`../hooks`) |
| `components/file-tree.tsx` | 1191 | 1199 | 99% | `useFileList`, `useGitStatus`, `useServerHealth`, `useDirectoryDownload`, `downloadFile` (2-arg vs 4-arg signature — see below), `getFileIcon`; also imports `file-tree-item` (now shared) |

**`file-tree.tsx`'s `downloadFile` call is the one real semantic wrinkle**:
`files/api/opencode-files.ts#downloadFile(path, name)` vs.
`project-files/api/opencode-files.ts#downloadFile(projectId, ref, path, name)`.
Both trees' `file-source.tsx` *already* normalize this to a 2-arg
`(filePath, fileName) => Promise<void>` shape for the `file-viewer` FileSource
(`download` field) — `file-tree.tsx` just needs to call that instead of
importing `downloadFile` directly, and the signature mismatch disappears.

**Plan for Stage 2**: introduce one new context/provider in this repo's
`file-browser` layer — not reusing `@/features/file-viewer`'s smaller
`FileSource` (that one is scoped to content-viewing and is owned by a
different tree) — call it `FileBrowserSource` (interface below). Each of
`files/file-source.tsx` and `project-files/file-source.tsx` grows a second
export, `useFileBrowserSource()` / `workspaceFileBrowserSource`, that bundles
the tree's own hook implementations + `getFileIcon` + `download` + capability
flags + label overrides. The 8 components above then move to
`file-browser/components/`, read `useFileBrowserSource()` instead of
`'../hooks'`, and drop 8-15% of the tree's remaining bulk. Each move should be
its own verified increment (tsc + targeted tests), same as Stage 1.

### `file-icon.tsx` — superset relationship, deferred pending visual QA

| Pair | files/ | project-files/ | Identity |
|---|---|---|---|
| `components/file-icon.tsx` | 450 | 305 | 67% |

`files/file-icon.tsx` is a strict superset of `project-files/file-icon.tsx` —
same icon-import list (just reordered) plus extra cases (a `kortix.yaml`
special SVG glyph, a few more extension branches) that `project-files` lacks.
Merging into one file (the superset) is mechanically simple and would unlock
sharing `file-breadcrumbs.tsx`, `file-explorer-toolbar.tsx`,
`file-thumbnail.tsx`, and part of `drive-grid/list-view.tsx` without any
`FileBrowserSource` plumbing at all. **Deferred anyway**: there is no test
covering icon-per-extension mapping in either tree, so a subtle branch-order
mistake during the merge would be a silent visual regression, not a
tsc/test failure. Do this only alongside (or after) adding a
snapshot/unit test enumerating extension → icon-name pairs, or with a manual
visual pass across both explorer UIs.

### Real UI differences — Stage 3+ (not started, needs `FileBrowserSource`)

| Pair | files/ | project-files/ | Identity | Notes |
|---|---|---|---|---|
| `components/drive-grid-view.tsx` | 580 | 728 | 52% | project-files adds version/checkpoint badges |
| `components/drive-list-view.tsx` | 473 | 509 | 38% | same |
| `components/drive-toolbar.tsx` | 341 | 236 | 33% | files has more mutation actions (upload/mkdir/etc.) |
| `components/file-preview-modal.tsx` | 75 | 49 | 49% | partially already source-adapted (uses `file-viewer` FileSource) |
| `components/file-thumbnail.tsx` | 65 | 56 | 48% | depends on `file-icon` |
| `components/file-explorer-page.tsx` | 928 | 555 | 48% | page-level orchestrator; project-files adds `drive-header.tsx` (Version selector, branch/commit UI) — a genuine, permanent superset, not a target for collapse |
| `components/file-browser.tsx` | 1005 | 1019 | 97% | the tree/grid/list orchestrator — very high identity, but pulls in *every* hook and the not-yet-shared components above; move last, once its dependencies are shared |

### Hooks — mostly real backend differences (Stage 4, case-by-case)

| Hook | files/ | project-files/ | Identity | Notes |
|---|---|---|---|---|
| `hooks/use-file-content.ts` | 57 | 58 | 65% | live read/write vs. ref-scoped read-only |
| `hooks/use-file-list.ts` | 78 | 60 | 61% | project-files has no mutation invalidation |
| `hooks/use-directory-download.ts` | 66 | 56 | 48% | ref-scoped zip endpoint differs |
| `hooks/use-git-status.ts` | 76 | 44 | 37% | live git status vs. diff-vs-ref |
| `hooks/use-workspace-search.ts` | 194 | 73 | 38% | project-files has a much thinner backend |
| `hooks/use-file-history.ts` | 107 | 97 | 35% | different commit source |
| `hooks/use-file-mutations.ts` | 169 | 57 | 28% | project-files is read-only — 57 lines are mostly stubs/no-ops |
| `hooks/use-file-search.ts` | 34 | 29 | 29% | different search backend |
| `hooks/use-binary-blob.ts` | 91 | 35 | 21% | project-files has no write path |
| `hooks/use-server-health.ts` | 70 | 46 | 19% | project-files fakes a static "healthy" (no daemon to poll) |

Even where the *shape* returned is identical (same field names, same
`isLoading`/`data` convention — this is what makes Stage 2's `FileBrowserSource`
possible at all), the *implementation* is a legitimate backend difference and
should stay two files. Do not attempt to collapse these hook bodies
themselves — only the components that consume them, via the seam.

### API layer — genuine backend differences, not a collapse target

`api/git-history.ts` (13% identity), `api/opencode-files.ts` (15%),
`search/workspace-search-service.ts` (9%) each hit a different backend
(`@kortix/sdk/files` vs `@kortix/sdk/projects-client`) with a different
request/response shape. These stay separate permanently; they're the actual
"data source" half of `FileBrowserSource`, referenced from each tree's
`file-source.tsx`, never imported directly by a shared component.

### Barrel files — stay per-tree (each re-exports its own superset)

`index.ts`, `hooks/index.ts`, `components/index.ts` in both trees already
point every moved item at `@/features/file-browser/...` (done in Stage 1).
They keep their tree-specific extra exports (`project-files` re-exports
`useBranches`, `useCommits`, `VersionSelector`, etc. that have no `files/`
counterpart) and should never be merged into one file — that would force
`files/` to statically depend on git-ref-only modules it has no business
importing.

### `features/files`-only (no `project-files` counterpart) — leave as-is

`path-utils.ts` (+`.test.ts`), `hooks/file-read-retry.ts` (+`.test.ts`). Retry
logic and path heuristics for a live, occasionally-flaky sandbox daemon —
not meaningful for a read-only frozen-ref view. No plan needed.

### `features/project-files`-only (no `files` counterpart) — leave as-is

`context.tsx`, `store/version-store.ts`, `components/{version-selector,
drive-header,checkpoint-detail-dialog,checkpoints-panel,change-requests-panel,
change-request-detail-dialog(+test),open-change-request-dialog,
diff-preview-banner,diff-renderer}.tsx`, `hooks/{use-branches,use-commits,
use-change-requests}.ts`, `api/{branches,commits,change-requests}.ts`. This is
`project-files`' real superset — branches/commits/change-requests UX that
`files` has no concept of (a live sandbox has no "commits" to browse). Not a
collapse target; this is why `project-files` is 12,016 lines against `files`'
9,947 to start with.

## `FileBrowserSource` design (for Stage 2+)

Both trees' `file-source.tsx` already establish exactly this seam for the
content viewer (`@/features/file-viewer`'s `FileSource`: `useFileContent`,
`useBinaryBlob`, `download`, `upload`, `Breadcrumbs`). Stage 2 needs a second,
broader interface — owned by `file-browser`, not `file-viewer` — for
everything the tree/grid/list/toolbar/status-bar/search/history components
need:

```ts
// apps/web/src/features/file-browser/file-browser-source.ts (Stage 2, not yet created)

export interface FileBrowserSource {
  /** Which backend this is — drives conditional UI, not behavior branching */
  kind: 'workspace' | 'project-ref';

  // Data hooks — identical call signature & return shape in both trees today
  // (verified in the Stage 2 table above); only the implementation differs.
  useFileList: (path: string) => UseFileListResult;
  useFileSearch: (query: string) => UseFileSearchResult;
  useGitStatus: () => UseGitStatusResult;
  useServerHealth: () => UseServerHealthResult;
  useCurrentProject: () => OpenCodeProjectInfo | undefined;
  useFileHistory: (path: string) => UseFileHistoryResult;
  useFileCommitDiff: (path: string, hash: string) => UseFileCommitDiffResult;
  useDirectoryDownload: () => UseDirectoryDownloadResult;
  useInvalidateFileList: () => (path?: string) => void;

  // Plain functions (already unified 2-arg shape via the file-viewer FileSource)
  download: (filePath: string, fileName: string) => Promise<void>;
  getIcon: FileIconResolver; // from each tree's own file-icon.tsx

  // Mutations — undefined entirely when capabilities.canWrite is false,
  // rather than present-but-no-op, so call sites can `if (source.mutations)`
  // instead of threading a boolean through every handler.
  mutations?: {
    upload: (...) => Promise<void>;
    delete: (...) => Promise<void>;
    mkdir: (...) => Promise<void>;
    rename: (...) => Promise<void>;
    create: (...) => Promise<void>;
    copy: (...) => Promise<void>;
  };

  capabilities: {
    canWrite: boolean;      // files: true, project-files: false
    hasGitStatus: boolean;  // both true today, kept explicit for future sources
    hasHistory: boolean;    // both true today
  };

  /** The handful of UI strings that legitimately differ between sources. */
  labels?: {
    historyContextMenuItem?: string; // "View History" vs "Checkpoint history"
  };
}
```

Delivered via a `FileBrowserSourceProvider` context (same shape as
`file-viewer`'s `FileSourceProvider`), constructed once per tree:
`files/file-source.tsx` exports a module-level `workspaceFileBrowserSource`
(hooks are module-stable, same reasoning as the existing `workspaceFileSource`
constant); `project-files/file-source.tsx` exports a
`useProjectFileBrowserSource()` hook (needs `projectId`/`ref` from
`useProjectContext()`, same reasoning as the existing
`useProjectFileSource()`).

Components move from `{files,project-files}/components/*.tsx` to
`file-browser/components/*.tsx` one at a time; each swaps its
`'../hooks'` / `'./file-icon'` imports for `useFileBrowserSource()` field
access, and each tree's thin per-tree file re-exports it wrapped in the
provider — exactly the `file-content-renderer.tsx` pattern already in
`files/components/file-content-renderer.tsx` /
`project-files/components/file-content-renderer.tsx` today.

## Staged migration plan

1. **Stage 1 (this change, DONE)**: zero-dependency + single-prop-injectable
   pairs → `features/file-browser/`. 5 pairs collapsed (`types`,
   `files-store`, `workspace-search-core`, `use-file-events`,
   `file-tree-item`). No `FileBrowserSource` needed yet.
2. **Stage 2 (next, not started)**: build `FileBrowserSource` +
   `FileBrowserSourceProvider` in both trees' `file-source.tsx`; move the 8
   "blocked on a hooks seam" components one at a time (suggested order:
   `file-explorer-status-bar.tsx` and `file-breadcrumbs.tsx` first — smallest
   blast radius — then `file-search.tsx`, `file-history-panel/popover.tsx`,
   `file-explorer-toolbar.tsx`, `file-tree.tsx` last since it's the biggest
   and pulls in the most hooks).
3. **Stage 3**: `file-icon.tsx` unification (superset merge), gated on adding
   icon-mapping test coverage first; then `drive-grid-view.tsx`,
   `drive-list-view.tsx`, `drive-toolbar.tsx`, `file-preview-modal.tsx`,
   `file-thumbnail.tsx` — these have real UI differences (project-files adds
   version/checkpoint badges) so expect each to end up as a shared component
   with a small number of `source.capabilities.*` / `source.kind` branches,
   not a byte-identical move.
4. **Stage 4**: `file-browser.tsx` (the orchestrator) and
   `file-explorer-page.tsx`, once everything they depend on is shared. Expect
   `file-explorer-page.tsx` to stay mostly separate — `project-files`'s
   version permanently composes `drive-header.tsx` (branch/commit/version
   picker), which has no `files/` analog.

Each stage should land as its own verified increment: `cd apps/web && npx tsc
--noEmit` (zero errors) and the targeted `bun test` scope, before starting
the next pair. Do not attempt Stage 2+ in one pass — the `FileBrowserSource`
seam is unproven until at least one real component (recommend
`file-explorer-status-bar.tsx`, the smallest) is moved through it and
verified.

## Verification (Stage 1)

```
cd apps/web && npx tsc --noEmit          # 0 errors
bun test src/features/files src/features/project-files src/features/workspace src/features/file-browser
  # 75 pass, 0 fail (15 files)
bun test src                              # 444 pass, 0 fail (70 files) — full frontend suite
```

## Files touched (Stage 1)

- New: `apps/web/src/features/file-browser/{types.ts, index.ts,
  store/files-store.ts(+.test.ts), hooks/use-file-events.ts,
  search/workspace-search-core.ts(+.test.mts),
  components/file-tree-item.tsx}`
- Deleted (superseded): 7 files from `features/files/**` (`types.ts`,
  `store/files-store.ts`, `store/files-store.test.ts`,
  `hooks/use-file-events.ts`, `search/workspace-search-core.ts`,
  `search/workspace-search-core.test.mts`, `components/file-tree-item.tsx`)
  and the same 6 from `features/project-files/**` (no
  `store/files-store.test.ts` counterpart existed there) — 13 files total,
  no third copy remains for any of them.
- Modified: every file in both trees that imported one of the moved modules
  (import path updated to `@/features/file-browser/...`), plus
  `files/components/file-browser.tsx` and
  `project-files/components/file-browser.tsx` (added `getIcon={getFileIcon}`
  prop at both `<FileTreeItem>` call sites; `project-files` additionally
  passes `historyLabel`), plus the one external deep-importer,
  `apps/web/src/components/deployments/create-deployment-dialog.tsx`
  (`@/features/files/types` → `@/features/file-browser/types`).
- Net: `features/files` 9,947 → 8,606 lines; `features/project-files` 12,016
  → 10,720 lines; `features/file-browser` (new, shared): 1,418 lines. Line
  count that used to exist twice now exists once.
