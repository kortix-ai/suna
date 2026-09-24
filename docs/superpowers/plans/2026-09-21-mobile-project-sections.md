# Mobile project sections: entry point, scope, and build order

## Context

Mobile chat is done. The project-level sections (agents, skills, connectors,
triggers, review, models, secrets) have no usable door on mobile.

Measured state on `revamp/mobile-ui` (2026-09-21):

- `FloatingMenuButton` (project home + thread) renders `MenuButton` left and
  `AgentPill` right. No `···` exists on either screen.
- `ProjectMoreSheet` opens only from `PageHeader`'s `···`, which renders only on
  tool pages. Path today: drawer → Files → `···`.
- Built and reachable only through that path: `ConnectorsPage` (1,416 lines),
  `SchedulesPage` (554), `WebhooksPage` (571), `SecretsNavPage` (839),
  `ChangesPage` (848).
- Built with no entry point: `AgentsPage` (378), `SkillsPage` (329).
  `LlmProvidersPage` (944) opens only from the model sheet's empty state.
- Missing: Review Center. `apps/mobile` has zero references to review items.
- `LlmProvidersPage` writes keys to the sandbox (`PUT {sandboxUrl}/auth/{id}`).
  Web's `ProviderConnect` writes project secrets (`upsertProjectSecret`). The
  two do not share a data path, and the mobile one needs a running sandbox.

Result: the work is one navigation change, one new page (Review), one rebuilt
page (Models), and small touch-ups. It is not seven new screens.

## Decisions (Jay, 2026-09-21)

1. Entry point: a `···` icon button right of `AgentPill`. It opens a sheet.
2. Connectors: remove the row. Keep `ConnectorsPage.tsx` in the repo, unreachable.
3. Other More-sheet rows stay, under a second group. Changes folds into Review.
4. Models scope = web's `QUICK_LLM_TABS`: Providers, Models, Custom. Gateway,
   Routing, Costs, Logs stay web-only.

Two written rules are overturned and must be edited in the same change:

- `apps/mobile/design.md:270` ("A Review button. Mobile has no Review Center").
- `apps/mobile/lib/session/connect-model.ts` header ("Mobile has no gateway
  model screen").
- Also update `design.md:211-212` (header row now has three controls; the row
  has a floating entry point again).

## Scope per section

| Section | Mobile scope | Source |
| --- | --- | --- |
| Agents | List, search, source view, "Edit in chat", "New in chat". Add: set default agent (star). | existing `AgentsPage` + `updateProjectDefaultAgent` |
| Skills | List, search, `SKILL.md` view, "Edit in chat", "New in chat". No file tree, no marketplace install. | existing `SkillsPage` |
| Connectors | None. Web only. | row removed |
| Triggers | Row label "Schedules": list, create, pause, run now, delete. Webhooks stays a separate page in group 2. | existing `SchedulesPage`, `WebhooksPage` |
| Review | New. All 5 kinds (`change`, `approval`, `output`, `decision`, `batch`), 3 segments, approve / dismiss / request changes / answer. No bulk select, no keyboard layer. | new `ReviewPage` |
| Models | New page, 3 segments: Providers, Models, Custom. No pooled account keys, no routing. | replaces `LlmProvidersPage` + web hand-off |
| Secrets | Existing project secrets page. Add one row: "Manage providers" → Models. | existing `SecretsNavPage` |

## Phase 0 — entry point and sheet (unlocks 5 sections, no new screens)

Files:

- `components/session/FloatingMenuButton.tsx` — no change; it already takes
  `children`.
- New `components/session/ProjectHeaderActions.tsx` — a `flex-row items-center`
  wrapper: `AgentPill` then `Button variant="ghost" size="icon"
  className="-mr-2.5 rounded-full bg-background"` with `DotsThreeIcon`.
  `AgentPill` loses its own `-mr-2.5` when the `···` follows it. `AgentPill`
  returns `null` under two agents; `···` always renders.
- `components/session/ProjectHome.tsx:212` and
  `components/session/SessionPage.tsx:1640` — render `ProjectHeaderActions`,
  pass `onOpenMore`.
- `components/session/ProjectScreen.tsx:838` — pass the existing `openMoreSheet`
  down to home and thread.
- `lib/session/dock-menu.ts` — replace `MORE_SHEET_GROUPS`:
  - Group 1 (untitled): Agents `page:agents`, Skills `page:skills`, Schedules
    `page:schedules`, Review `page:review`, Models `page:models`, Secrets
    `page:secrets-nav`.
  - Group 2 "More": Webhooks, Commands, Channels, Members, Terminal, Sandbox, Dev.
  - Removed rows: Connectors, Changes.
  - Add `'review' | 'models'` to `DockIconKey`; map them in
    `components/session/dock-icons.ts`; add icons to `lib/icons/index.ts`.
- `components/session/ProjectMoreSheet.tsx` — render rows as
  `SettingsGroup` + `SettingsRow` (design.md: icon · label · trailing, no
  description). Badge moves from `page:changes` to `page:review`; prop renames
  `changesBadgeCount` → `reviewBadgeCount`. Until Phase 2 lands, the Review row
  points at `page:changes` with the existing count.
- `stores/tab-store` `PAGE_TABS` + `components/session/page-tab-icons.ts` —
  register `page:review`, `page:models`.
- `design.md` — edit lines 211, 212, 265-272 to the new law.

Stack law is untouched: every row calls `navigateToPage`, which renders inside
the single `view` route. `lib/session/project-stack.ts` does not change.

## Phase 1 — Agents, Skills, Secrets touch-ups

- `AgentsPage`: star control on the row → `updateProjectDefaultAgent`
  (`@kortix/sdk`, already exported). Add `useSetProjectDefaultAgent` to
  `lib/projects/hooks.ts`; invalidate `projectKeys.detail`.
- `AgentsPage` + `SkillsPage`: audit against `design.md` and
  `apps/mobile/CLAUDE.md` (Button sizes, `Text` variants, `PressableSurface`,
  icons from `@/lib/icons`). Fix only what violates the law.
- `SecretsNavPage`: one `SettingsRow` "Manage providers" →
  `navigateToPage('page:models')`.
- Delete nothing in this phase.

## Phase 2 — Review

SDK first (load the `sdk` skill; TDD is mandatory there):

- Move the framework-free review logic from
  `apps/web/src/features/review-center/` into
  `packages/sdk/src/core/review/`: `types.ts` (165 lines), `map.ts` (295),
  `review-reducer.ts` (172), `review-actions.ts` (160), with their tests
  (`map.test.ts`, `review-reducer.test.ts`, `review-actions.test.ts`).
  `review-meta.ts` stays in web (it imports `@/i18n` and `react`).
- Export from `packages/sdk/src/index.ts` (three synchronized export edits per
  the skill). Web files become `export * from '@kortix/sdk'` shims.
- No new SDK React hooks: mobile does not import `@kortix/sdk/react`
  (`packages/sdk/README.md:754`).

Mobile:

- `lib/projects/hooks.ts` — `useReviewItems(projectId, segment)` (8 s
  `refetchInterval`, matches web), `useActReviewItem`, `useResolveApproval`,
  over `listReviewItems` / `actReviewItem` / `resolveApproval`. Verdict routing
  comes from the moved `review-actions.ts`: `cr:<id>` → existing
  `useMergeChangeRequest` / `useCloseChangeRequest`; `call:<id>` →
  `resolveApproval`; native ids → `/act`.
- New `lib/review/review-meta.ts` — kind → `AppIcon` + label, risk → `Badge`
  variant. Pure data, bun-tested, no icons imported in the tested module
  (icon keys resolved in a `.tsx` sibling, same split as `dock-menu.ts`).
- New `components/pages/ReviewPage.tsx` — `PageHeader` + `PageContent`;
  `ToggleGroup` for Needs you / Waiting / Done; `ListRow` per item (kind icon,
  title, agent, relative age, risk badge); `EmptyState` per design.md:115.
  `PageHeader.rightActions`: "Versions" → `page:changes` (keeps the branches tab
  reachable after the Changes row is removed).
- New `components/review/ReviewDetailSheet.tsx` — one `Sheet`, body by kind:
  - `change`: summary, what changed, verification, per-file diff via existing
    `components/diff/PatchDiffView.tsx` + `useChangeRequestDiff`. Actions:
    Approve (merge), Dismiss (close), Request changes (`SheetTextInput`).
  - `approval`: one block per action with redacted args; Approve / Deny each.
    Never quick-decidable, same as web's `isQuickDecidableApproval`.
  - `decision`: options as picker rows; recommended option marked.
  - `output`: text preview or `ArrowUpRight` row to `previewUrl`.
  - `batch`: item list + one Approve.
  - Destructive verdicts confirm in an `AlertDialog` opened after the sheet
    closes (design.md:126).
  - Footer row "Open session" → the originating thread.
- Gate actions on `project.review.act` through the existing `useProjectAccess`.
- `ProjectScreen.tsx` — add the `page:review` branch; pass `needs_you` count to
  `ProjectMoreSheet` and show a dot on the header `···` when it is above 0.
- Point the Review row at `page:review`.

## Phase 3 — Models

- New `components/pages/ModelsPage.tsx`, `ToggleGroup`: Providers / Models / Custom.
  - Providers: catalog list with search; tap → sheet with one masked
    `SheetTextInput`; save = `upsertProjectSecret`, remove =
    `deleteProjectSecret` (hooks exist, `lib/projects/hooks.ts:652,662`).
    ChatGPT subscription: device-code flow via `startProjectProviderOAuth` /
    `pollProjectProviderOAuth` (URL + code; no popup).
  - Models: grouped by provider, search, `Switch` per model
    (`setProjectModelEnablement`), row sheet with "Set as project default" /
    "Set as my default" (`setModelDefault` / `clearModelDefault`). Default
    model's switch is locked, as on web.
  - Custom: port web's 6-field form; reuse
    `lib/kortix/custom-provider-config.ts` validation; write
    `CUSTOM_<ID>_API_KEY`; show the generated `opencode.jsonc` snippet with Copy.
- New hooks in `lib/projects/hooks.ts`: `useProjectModelEnablement`,
  `useModelDefaults`, `useProviderOAuth`. All over existing SDK client functions.
- `SessionPage.tsx:615` and `lib/session/connect-model.ts` — "Connect provider"
  navigates to `page:models` for gateway and non-gateway projects. Delete
  `openProjectModelsOnWeb` and its test once no caller remains.
- `LlmProvidersPage.tsx` — remove its `view` branch and file after `ModelsPage`
  passes verification on a non-gateway project. It is the only caller of the
  sandbox `/auth/{id}` path.

## Out of scope

- Connectors on mobile, marketplace skill install, agent editor (permissions,
  grants, prompt), trigger session-mode / filter / access editors, pooled
  account keys, gateway routing / costs / logs, review bulk select.
- Deleting the unreachable legacy code (`components/agents/*`,
  `components/triggers/*`, `ScheduledTasksPage`, `ApiKeysPage`,
  `lib/triggers/hooks.ts`, `lib/models/*`). Track as a separate cleanup.

## Branch and delivery

- Same canonical branch: `revamp/mobile-ui`, draft PR #4372. One commit per
  phase. No merge to `main` without Jay's explicit approval.
- Phase 2 touches `packages/sdk` and `apps/web` shims. Those ride the same
  branch; run the SDK gates and paste the output in the turn.
- Linear tracking: Jay names the project before any issue is created.

## Verification

Per phase, narrowest first:

1. `cd apps/mobile && bun test lib/session/dock-menu.test.ts
   lib/icons/icon-imports.test.ts lib/session/project-stack.test.ts` — new
   cases: group 1 holds exactly six rows in order; no `page:connectors`; every
   `pageId` exists in `PAGE_TABS`.
2. `bun test` in `apps/mobile`; `npx tsc --noEmit` compared against the 5-error
   baseline (memory: mobile has no tsc gate).
3. Phase 2: `pnpm test -- --sdk-only` (moved review tests pass inside the SDK);
   `apps/web` `tsc --noEmit` against its ~15-error baseline to prove the shims
   resolve; `bun test apps/web/src/features/review-center`.
4. Real API, local stack (`pnpm dev`, JWT minted per root `CLAUDE.md`):
   - `POST /v1/projects/:id/review/items` to submit a `decision` item, then
     `GET .../review/items?segment=needs_you` returns it, then
     `POST .../items/:id/act {verdict:"answer"}` returns 200 and the item moves
     to `done`.
   - `PUT /v1/projects/:id/model-enablement` then `GET .../model-picker` shows
     the model disabled.
   - `POST /v1/projects/:id/secrets` with a provider key, then `GET` shows
     `configured: true` and no value.
5. Simulator (memory recipe: temp route under `app/share`, `simctl openurl` +
   `simctl io screenshot`), iOS and Android, light and dark:
   - home and thread headers with 1 agent (pill hidden) and 2+ agents;
   - the sheet, both groups, badge present;
   - Review list per segment and each of the 5 detail bodies;
   - Models three segments; Secrets "Manage providers" row.
6. Unverified by design: a live ChatGPT device-code login (needs a real
   subscription account). State it in the hand-off.
