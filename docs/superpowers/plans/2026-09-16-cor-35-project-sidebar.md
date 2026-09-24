# COR-35 — Clean up the project sidebar (mobile)

Spec: Linear COR-35 and its sub-issues COR-49, COR-51, COR-53, COR-54, COR-56,
COR-58, COR-59, COR-61 (project Kortix Mobile). The ticket text is the binding
authority. `apps/mobile/design.md` is the visual law.

Worktree: `/Users/jay/root/kortix/suna-mobile`, branch `revamp/mobile-ui`.
All paths below are relative to `apps/mobile/` unless they start with `apps/`.

## Target sidebar (after all tasks)

```
┌──────────────────────────────────────────┐  full screen width (COR-49)
│ [Kortix logomark]                    [×] │  logo → Projects list; × closes
│ (💬 Sessions)                             │  rounded-full buttons (COR-51)
│ (🗂 Files)                                │  (COR-54)
│                                           │  Review: not rendered (COR-56)
│ (▦ All projects)                          │  kept: the COR-69 path to the list
│                                           │
│  ◌ Session title                          │  recent sessions, scrolls
│  ● Session title   (active row highlight) │  no collapsible "Sessions" header
│  …                                        │
│  Previous chats (LegacyChatsSection)      │  unchanged, end of scroll content
│                                           │
│ [+ New session] (blue pill)          (🙂) │  pinned bottom bar (COR-61)
└──────────────────────────────────────────┘
```

Removed: Search row + `CommandPalette` (COR-58), user card footer (COR-59),
New session row at the top (COR-61), the sandbox-scoped "Projects" collapsible
tree (it only renders with a session sandbox URL, and the drawer only opens on
project home), the collapsible "Sessions" header and its chevron animation.

## Global Constraints

- Follow `apps/mobile/design.md` and `apps/mobile/CLAUDE.md`. Read both first.
- `Button` from `@/components/ui/button`: pick `variant` + `size`. The only
  visual class allowed on a `Button` is `rounded-full`. No `h-*`, `w-*`,
  padding, text size, or font-weight classes on a `Button` or its `Text`.
  Layout classes (`self-start`, `mt-*`, `flex-1`) are allowed.
- Colours come from tokens (`bg-*`/`text-*` classes, `THEME.*`, `withAlpha`).
  No hex/rgb literals. Every surface works in light and dark mode.
- Header actions and back buttons use `PlatformButton`
  (`components/kortix/platform-button.tsx`).
- Confirmations use `AlertDialog`, never `Alert.alert`. Results use
  `useToast()` (returns the toast functions directly), never `Alert.alert`.
- A destructive confirmation opens only after the sheet that triggered it has
  closed — never two overlays at once.
- No descriptions/subtitles under row labels. Sentence case labels.
- Press feedback: `active:opacity-*` or `active:bg-*` classes. Never a function
  `style` on a component that also has `className` (NativeWind discards it).
- Navigation law (COR-69): never `router.push('/projects/<id>')`; the Projects
  list opens only with `router.replace('/projects')` from the project menu.
  The project stack never grows deeper than one screen over project home.
- Logic that can be pure lives in `lib/**` with a `bun test` file next to it.
  `bun test` cannot load React Native modules: pure modules import no RN,
  lucide, expo, or zustand.
- Data calls go through `@/lib/projects/projects-client` (re-exports of
  `@kortix/sdk`). No raw `fetch` in components.
- Gates, run from `apps/mobile`:
  - `npx tsc --noEmit -p tsconfig.json` — no new errors versus the baseline
    in the ledger (`.superpowers/sdd/2026-09-16-cor-35-project-sidebar/tsc-baseline.txt`).
  - `bun test` — no new failures.
- **Git: never commit, stage, stash, checkout, reset, clean, or rebase.**
  Other sessions share this worktree and have uncommitted edits in
  `components/session/ProjectScreen.tsx`, `contexts/SandboxContext.tsx`,
  `lib/platform/hooks.ts`, `lib/projects/projects-client.ts`,
  `lib/session/connect-step.ts`. Edit only the files your task names. Never
  revert or reformat lines you did not write. Use `git diff -- <path>` and
  `git show HEAD:<path>` to read history; they write nothing.
- Do not run prettier `--write` on whole files.
- No Linear ids (COR-xx) in code, comments, or file names.

## Task 0: Project stack glue (ProjectScreen + ProjectRoutes)

Files: `components/session/ProjectScreen.tsx`,
`components/session/ProjectRoutes.tsx`, create `app/projects/[id]/sessions.tsx`,
create `app/projects/[id]/files.tsx`.

1. Full-width drawer (COR-49): in the `<Drawer>` props set
   `drawerStyle.width` to `'100%'`. Keep `drawerType="slide"`, the transparent
   overlay, and the swipe settings. Update the comment above `renderDrawer`
   (it mentions CommandPalette, which Task 3 deletes).
2. Stop passing `sessionSandboxUrl` to `ProjectLeftDrawer` (the prop is
   optional; Task 3 removes it from the interface). Remove it from the
   `useCallback` dependency list.
3. Register two screens in the project `AppStack`, after `view`:
   `<AppStack.Screen name="sessions" />` and `<AppStack.Screen name="files" />`.
   Export route-name constants next to `PROJECT_VIEW_ROUTE` in
   `ProjectRoutes.tsx`: `PROJECT_SESSIONS_ROUTE = 'sessions'`,
   `PROJECT_FILES_ROUTE = 'files'`.
4. Extend `ProjectRouteValue` with two stable callbacks that the Sessions page
   (Task 4) needs, wired in `ProjectScreen` to the existing handlers:
   - `openProjectSession: (session: ProjectSession) => void` → the existing
     `handleOpenProjectSession`.
   - `projectId: string`.
   Keep them referentially stable (refs or `useCallback`), matching how
   `goHome` is documented as stable.
5. `ProjectHomeRoute` pushes `view` only when home is focused. Opening a
   session from a route that covers home (`sessions`) must end with ONE screen
   over home: the view. Add and export a hook
   `useOpenProjectSessionFromRoute()` in `ProjectRoutes.tsx` that returns
   `(session) => { navigation.dispatch(StackActions.replace(PROJECT_VIEW_ROUTE)); openProjectSession(session); }`
   — or an equivalent that yields stack `[index, view]` with no extra
   transition. Confirm against `ProjectHomeRoute`'s effect (it skips the push
   when `view` is already in the routes) and `ProjectViewRoute`'s effects
   (it pops when the store is home). Document the chosen order in a comment.
6. Create the two route files as stubs that Tasks 2 and 4 replace. Each
   default-exports a component that renders `null`. Do not add route
   components to `ProjectRoutes.tsx`.
7. The Android `BackHandler` in `ProjectScreen` (close drawer → pop view →
   swallow) must also pop `sessions` / `files` when either is on top. Read
   the handler and extend it if it only checks for `view`.

Done when: tsc shows no new errors; `ProjectLeftDrawer` renders at 100% width;
the two routes exist and are registered; the new context fields and hook are
exported and documented.

## Task 1: Session list helpers (pure, TDD)

Files: create `lib/session/session-list.ts`, create
`lib/session/session-list.test.ts`.

Port from the web (read these first):
- `apps/web/src/features/workspace/project-sidebar/project-session-list-helpers.ts`
  (`getSessionDisplayTitle`, `sessionLastActivityAt`, `shortRelative`)
- `apps/web/src/features/workspace/project-sidebar/session-grouping.ts`
  (activity buckets only: Today, Yesterday, This week, Older; `showHeaders`)
- `apps/web/src/components/projects/session-label.ts` (`sessionDisplayStatus`)

Exports (types from `@kortix/sdk` via `@/lib/projects/projects-client` type
imports only — type imports are erased and safe under `bun test`):
- `sessionDisplayTitle(session): string` — rename, else generated title, else
  `'New session'`. Mirror the web field order exactly.
- `type SessionDisplayStatus = 'starting' | 'running' | 'stopped' | 'failed' | 'needs-you'`
- `sessionDisplayStatus(session): SessionDisplayStatus` — queued / branching /
  provisioning → starting; running → running; stopped / completed → stopped;
  failed → failed; review pending → needs-you (web precedence).
- `sessionLastActivityAt(session): number` (ms epoch).
- `shortRelative(ms: number, now: number): string` — "now"/"5m"/"2h"/"3d"… per
  web.
- `groupSessionsByActivity(sessions, now: number): { sections: Array<{ id: 'today'|'yesterday'|'week'|'older'; label: string; sessions: ProjectSession[] }>; showHeaders: boolean }`
  — sections in that order, empty sections omitted, sessions sorted by last
  activity descending, `showHeaders` true only when more than one section
  has sessions. Bucket boundaries use the device-local calendar day like web.
- `filterSessionsByTitle(sessions, query: string): ProjectSession[]` — trimmed,
  case-insensitive substring match on `sessionDisplayTitle`; empty query
  returns the input.

TDD: write the failing tests first, run `bun test lib/session/session-list.test.ts`,
watch them fail, implement, re-run. Cover: every status mapping incl.
needs-you precedence; title fallbacks; each bucket boundary (midnight, start
of yesterday, 7-day edge); `showHeaders` with 0/1/2 populated sections; sort
order; `shortRelative` unit steps; search trim + case.

## Task 2: Files route (COR-54 page)

Files: `app/projects/[id]/files.tsx` (replace the stub),
`components/pages/FilesNavPage.tsx`.

Read `FilesNavPage.tsx`, `components/kortix/page-header.tsx`
(`PageHeader`, `PageBackProvider`), and how `ProjectViewRoute` provides back.

1. `/projects/[id]/files` renders `FilesNavPage` for the route's project id
   (`useLocalSearchParams`). Wrap it in `PageBackProvider` whose handler is
   `router.back()` so its `PageHeader` shows Go back. Back (button, iOS swipe,
   Android back) returns to project home.
2. Files show in a **grid by default**. Keep the existing list/grid toggle;
   only the default changes. If the page persists the choice, the default for
   a user with no stored choice is grid.
3. Tapping a file still opens the existing file viewer.
4. `FilesNavPage` is also reachable from the dock (`page:files-nav`). Keep that
   entry working; do not duplicate the page.

Done when: route renders with back navigation; grid default; tsc clean versus
baseline.

## Task 3: Sidebar rewrite (COR-49 close, COR-51, COR-54 button, COR-56, COR-58, COR-59, COR-61)

Files: `components/session/ProjectLeftDrawer.tsx`; delete
`components/session/CommandPalette.tsx`.

Read first: `design.md`, `components/ui/button.tsx`,
`components/kortix/platform-button.tsx`, `components/kortix/KortixLogo.tsx`,
`components/settings/ProfilePicture.tsx` (and how `AccountPage` shows the
user's avatar), `components/menu/LegacyChatsSection.tsx`,
`app/(tabs)/_layout.tsx` or wherever the Account tab reads the profile.

Build the target sidebar drawn at the top of this plan:

1. **Header row:** Kortix logomark (top left, tap → `router.replace('/projects')`
   after `onClose()`, `accessibilityLabel="All projects"`), and a close control
   on the right (`PlatformButton`, `xmark` / X icon, `accessibilityLabel="Close sidebar"`)
   calling `onClose()`. The drawer is full width, so this is the tap-to-close
   affordance; swipe-to-close stays.
2. **Nav buttons**, stacked, left-aligned, each `Button variant="secondary"`
   (or `ghost` if secondary reads too heavy against `bg-chrome-background` —
   decide by reading the tokens, record the choice in the report)
   `className="rounded-full self-start"` with a leading icon + label:
   - Sessions — message icon → `onClose()` then
     `router.push(\`/projects/${projectId}/sessions\`)`.
   - Files — folder icon → `onClose()` then
     `router.push(\`/projects/${projectId}/files\`)`.
   - Review — **not rendered**: mobile has no Review Center (the web Review
     button opens the Review Center inbox; mobile `ChangesPage` is only change
     requests). Leave no dead code or flag for it.
   - All projects — grid/albums icon → `onClose()` then
     `router.replace('/projects')`.
   Icons: lucide-react-native, matching the icon size/stroke used by
   `settings-list` rows (18 / 2.2), coloured with a token class.
3. **Recent session list** in a `ScrollView` below the buttons: the current
   `ProjectSessionListItem` rows (status dot + title, active row highlighted),
   no collapsible header, no chevron. Loading: keep a small loader (use
   `KortixLoader` if design.md prefers it over `ActivityIndicator`). Empty:
   "No sessions yet" muted text. `LegacyChatsSection` renders at the end of the
   scroll content. The scroll content's bottom padding clears the bottom bar.
4. **Bottom bar**, absolutely positioned at the bottom, above
   `insets.bottom` (use `max(insets.bottom, 16)` like design.md's pinned
   bottom action), `px-5`, row with space-between:
   - New session: `Button` `rounded-full`, blue from a theme token (the
     `kortix-blue` token; add a Button variant only if no token-driven way
     exists, and then record it), plus icon + "New session", content width.
     Calls `haptics.tap()`, `onClose()`, `onNewSession()`.
   - Avatar: round icon-size button showing the user's profile picture only
     (fallback initial when there is no photo), no name/email. Tap →
     `haptics.tap()`, `onClose()`, `router.push('/account-settings')`.
   The session list scrolls under the bar; give the bar a `bg-chrome-background`
   surface (or a fade) so rows never show through the buttons.
5. **Delete:** the Search row, `paletteOpen` state, the `CommandPalette` mount
   and import, `components/session/CommandPalette.tsx` itself, the user card,
   `hasUpdate`, `planLabel`, `userChalk`, the "New session" top row, the
   Projects collapsible tree and `useKortixProjects` / `useTabStore` /
   `useSessions` usage that only served removed UI, `AnimatedCollapsible`,
   `AnimatedChevron`, and the `sessionSandboxUrl` prop. Remove imports that
   become unused. `lib/utils/file-search.ts` stays (`useMentions` uses it).
   Grep the app for any other `CommandPalette` reference and remove it.
6. Replace the file header comment with an accurate description of the new
   sidebar (no "Task 6 / Task 27" history).
7. Update `apps/mobile/design.md`: add a "Project sidebar" section (layout,
   exact values, what is intentionally absent), and fix the Project stack row
   so it mentions the `sessions` and `files` routes.

Done when: every sub-issue checkbox above holds in code; no reference to
`CommandPalette` remains (`grep -rn CommandPalette apps/mobile --include='*.ts*'`
prints nothing outside node_modules); tsc clean versus baseline.

## Task 4: Project Sessions page (COR-53)

Files: create `components/session/ProjectSessionsPage.tsx`, replace
`app/projects/[id]/sessions.tsx` stub; may add re-exports to
`lib/projects/projects-client.ts` (append-only, do not touch other lines);
may add a pure helper to `lib/session/session-list.ts` with a test if needed.

Uses Task 1 helpers and Task 0's `useOpenProjectSessionFromRoute()`.

Read first: `design.md`; `components/kortix/settings-list.tsx`
(`SettingsHeader`), `components/kortix/search-list-header.tsx` /
`SearchBar.tsx`; `apps/web/src/features/workspace/project-sessions/session-row.tsx`
(row actions); `components/session/SessionRenameSheet.tsx`,
`SessionShareSheet.tsx`; the restart/delete handlers in `ProjectScreen.tsx`
(~lines 590–760) for the exact calls and cache invalidation; the
`ProjectActions` sheet pattern used on the Projects tab
(`app/(tabs)/projects.tsx`) for the long-press sheet.

1. Header: `SettingsHeader title="Sessions"` (Go back → `router.back()`).
2. Search field at the top (`SearchBar`/`SearchListHeader` per design.md
   Inputs table), filters with `filterSessionsByTitle`.
3. List (`FlatList` or `SectionList`) grouped with `groupSessionsByActivity`;
   section headers only when `showHeaders`. Section title style = design.md
   group title (`Text variant="muted"`, sentence case, `px-4 mb-2`).
4. Row: status mark · title (one line) · short relative time (muted,
   tabular). Status mark must make Running and Stopped look different
   (e.g. filled green vs muted outline), Starting animated or distinct,
   Failed red, Needs you distinct. Colours from tokens. Tap → open the
   session via `useOpenProjectSessionFromRoute()`.
5. Long press → haptic + bottom `Sheet` (ProjectActions pattern) titled with
   the session title, one untitled `SettingsGroup`: Rename, Share, Restart,
   Stop (only when `sessionDisplayStatus` is running), Delete (destructive).
   - Rename → `SessionRenameSheet` for that session.
   - Share → `SessionShareSheet` for that session.
   - Restart → `restartProjectSession`, toast on success/failure.
   - Stop → the SDK's stop call re-exported through `projects-client.ts`. If
     the SDK has no stop call, report NEEDS_CONTEXT instead of hand-rolling a
     fetch.
   - Delete → `AlertDialog` (after the sheet closes), destructive pill +
     cancel pill; runs `deleteProjectSession`; keeps the dialog open while
     running; failure shows in the dialog description.
   - Every action refreshes the list (invalidate the `useProjectSessions`
     query key).
6. States: loading → `KortixLoader`; no sessions → "No sessions yet"; search
   with no matches → "No matching sessions". Plain centred muted text, no
   icon, no card.
7. Pull to refresh.
8. **No filter, grouping, or ordering controls anywhere on the page.**

Done when: all COR-53 checkboxes hold in code; tsc clean versus baseline;
`bun test` passes.
