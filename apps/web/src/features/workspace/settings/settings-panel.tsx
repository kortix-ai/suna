'use client';

/**
 * The merged settings overlay shell — ported from the legacy Customize
 * overlay's panel onto one vertical `Tabs` root instead of a hand-rolled
 * rail-button/section switch. Every comment below that isn't about the Tabs
 * wiring itself is carried forward from that file because it documents a
 * real bug that was fixed there; this is a port, not a rewrite.
 *
 * **Task 5b — the cutover.** The legacy Customize panel is deleted;
 * `ProjectShell` now mounts THIS panel instead (see
 * `project-layout/project-shell.tsx`). Every literal `openCustomize(...)`
 * call site was repointed to `openSettings(...)` against
 * `stores/settings-panel-store.ts`, and every `/customize/*` route now
 * redirects to its `/settings/*` equivalent via `legacySectionRedirect` —
 * see that task's report for the full file list.
 *
 * Tab-pane CONTENT is intentionally NOT wired here. Every pane below renders
 * a bare `SettingsSectionHeader` as a placeholder; `features/workspace/
 * settings/tabs/*.tsx` (one file per tab, added tab-by-tab in later tasks)
 * replaces each placeholder as it's built. Reusing the existing
 * `customize/sections/**` views directly here was originally blocked:
 * `gateway-view.tsx` (`LlmManagementView`), `connectors-view.tsx`,
 * `members-view.tsx`, `secrets-view.tsx`, and `marketplace-section-
 * button.tsx` all read the legacy Customize store directly for panel
 * navigation (which tab is active, whether the panel is open, how to jump
 * elsewhere). Mounting them under THIS panel would have made them read the
 * wrong store — the legacy one, which this panel never opened.
 *
 * That blocker is gone: all five now read `useSettingsNav()` (see
 * `features/workspace/shared/settings-nav-context.tsx`) instead of a store
 * directly, and THIS panel already provides it below (`buildSettingsPanel-
 * SettingsNav` / `<SettingsNavProvider>`).
 *
 * **Task 5b2 update.** Fifteen of the legacy panel's `SectionContent`
 * cases (fourteen `case` labels plus the `llm-*` prefix branch) are now
 * wired onto their mapped tab via `SettingsTabPane` below: `commands`,
 * `marketplace`, `secrets`, `channels`, `voice`, `computers`, `schedules`,
 * `webhooks`, `git`, `review`, `sandbox`, `members`, `settings`, `upgrade`,
 * and `llm-*` become `instructions`, `marketplace`, `secrets`, `channels`,
 * `voice`, `computers`, `schedules`, `webhooks`, `repositories`, `review`,
 * `sandbox`, `members`, `general`, `upgrades`, and `models`. `sandbox` here
 * still renders the UNSPLIT `SandboxView` (templates + build log together);
 * splitting off `snapshots` (build log only) is a later task, so `snapshots`
 * stays a placeholder.
 *
 * **Task 7 update.** `profile` is wired to the real `ProfileTab` (see
 * `tabs/profile-tab.tsx`) — the first of the ten still-new, account-scoped
 * surfaces to get real content. It renders with no `projectId` dependency
 * (see `SettingsTabPane` below), unlike every project-scoped case above it.
 *
 * **Task 8 update.** `preferences` is wired to the real `PreferencesTab`
 * (see `tabs/preferences-tab.tsx`) — same account-scoped, no-`projectId`
 * shape as `profile`.
 *
 * **Task 9 update.** `connected` is wired to the real `ConnectedAccountsTab`
 * (see `tabs/connected-tab.tsx`) — same account-scoped, no-`projectId`-
 * required shape as `profile`/`preferences` above, but it ALSO reads
 * `project?.account_id` (threaded down as `accountId`, computed here from the
 * same project-detail query the IAM caps probe already uses) because one of
 * its three rows (GitHub) is account-scoped, not project- or user-scoped —
 * see that file's header comment.
 *
 * **Task 11 update.** `billing` is wired to the real `BillingTab` (see
 * `tabs/billing-tab.tsx`) — same account-scoped shape as `connected` (reads
 * `accountId`, no `projectId` required). It renders nothing at all without
 * `billing.write` on the resolved account AND `isBillingEnabled()` — see
 * that file's header comment.
 *
 * **Task 12 update.** `usage` is wired to the real `UsageTab` (see
 * `tabs/usage-tab.tsx`) — same account-scoped shape as `billing`/`connected`.
 * It renders nothing without `account.write` on the resolved account, but —
 * unlike `billing` — does NOT also require `isBillingEnabled()`: session
 * costs stay available with billing off, matching `sectionVisible.
 * transactions` on the source page.
 *
 * **Task 13 update.** `groups` is wired to the real `GroupsTab` (see
 * `tabs/groups-tab.tsx`) and `roles` to the real `RolesTab` (see
 * `tabs/roles-tab.tsx`) — same account-scoped shape as `billing`/`usage`.
 * The two gate differently, matching `app/(app)/accounts/[id]/page.tsx`
 * exactly (see each file's header comment): Groups has no permission gate
 * at all (every member reaches the pane; only its CONTENT is
 * entitlement-gated, showing `EnterpriseUpsell` in place of the real view
 * on a non-`rbac` account); Roles additionally requires `role.create` as a
 * whole-tab gate on top of that same entitlement content-gate. The
 * remaining three (`audit`, `api-keys`, `experimental`, plus `snapshots`
 * from Task 5b2) stay placeholders — later phases build them.
 *
 * **Task 14 update.** `identity` is wired to the real `IdentityTab` (see
 * `tabs/identity-tab.tsx`) — same account-scoped shape as `billing`/
 * `usage`/`roles`. It gates the whole tab on `account.write`
 * (`app/(app)/accounts/[id]/page.tsx:358`), and separately gates its
 * CONTENT on `!!(entitlements?.sso || entitlements?.scim)` — an OR, and
 * deliberately NOT `rbac` — showing `EnterpriseUpsell` in place of the
 * real `SsoCard`/`ScimCard` on a non-entitled account, same mechanism
 * split as `groups`/`roles`.
 *
 * **Task 13b update.** Found in review of Task 13: `billing`/`usage`/`roles`
 * enforced their whole-tab permission gate ONLY by returning `null` from
 * their container, same as this comment used to document as intentional —
 * so a denied user still saw the rail row and clicked into an empty pane,
 * unlike the source page (`app/(app)/accounts/[id]/page.tsx:354-365`'s
 * `sectionVisible` map), which never rendered that row at all.
 * `ACCOUNT_TAB_PERMISSION` below now gives the rail an account-scoped
 * counterpart to `GATED_TAB_SECTION` (its project-scoped analogue), so a
 * denied account-scoped tab is ABSENT from the rail — see that constant's
 * comment and `isSettingsTabAllowed`'s for the full reasoning, including the
 * fail-open contract and the residual gap it does NOT close. `groups` is
 * deliberately still absent from that map: it has no whole-tab permission
 * gate, only an entitlement gate on its CONTENT (`EnterpriseUpsell`), which
 * must keep showing the tab — permission gating and entitlement gating stay
 * two different mechanisms. The per-tab `return null` guards in
 * `billing-tab.tsx`/`usage-tab.tsx`/`roles-tab.tsx` are UNCHANGED — they stay
 * as a defensive backstop, not removed.
 *
 * **Task 15 update.** `audit` is wired to the real `AuditTab` (see
 * `tabs/audit-tab.tsx`) and added to `ACCOUNT_TAB_PERMISSION` — same
 * account-scoped shape as `billing`/`usage`/`roles`/`identity`, but its own
 * `audit.read` whole-tab gate (`app/(app)/accounts/[id]/page.tsx:363`), NOT
 * `account.write`. Its CONTENT separately gates on
 * `!!entitlements?.auditAccess` (`:309`) — its own leaf, not `rbac`
 * (Groups/Roles) and not `sso || scim` (Identity) — showing
 * `EnterpriseUpsell` in place of the real log on a non-entitled account,
 * same mechanism split as `groups`/`roles`/`identity`.
 *
 * **Task 16 update.** `api-keys` is wired to the real `ApiKeysTab` (see
 * `tabs/api-keys-tab.tsx`) and added to `ACCOUNT_TAB_PERMISSION` — same
 * `account.write` whole-tab gate as `billing`/`usage`/`identity`
 * (`app/(app)/accounts/[id]/page.tsx:362 tokens: canWriteAccount === true`).
 * Unlike `audit`/`identity`, it has no separate entitlement content-gate —
 * the source page's `tokens` branch is a single `canWriteAccount` condition
 * around two cards, nothing else — so its content is unconditional once past
 * the whole-tab gate, same single-probe shape as `billing`/`usage`. Every
 * account-scoped tab this panel builds is now wired; no placeholder remains
 * among them.
 *
 * **Task 18 update.** `general` is rewired from `SettingsView`
 * (`customize/sections/view/settings-view.tsx`, now deleted) to the real
 * `GeneralTab` (see `tabs/general-tab.tsx`) — workspace name, icon, the
 * sandbox-provider pin, and a Delete-workspace danger zone. `experimental`
 * is wired for the first time to the real `ExperimentalTab` (see
 * `tabs/experimental-tab.tsx`) — one row per `experimental_features` catalog
 * entry. Both are project-scoped (`projectId`, no `ACCOUNT_TAB_PERMISSION`
 * entry — that map is for account-permission tabs only). `SettingsView` had
 * no other caller (`grep -rn "<SettingsView" src` matched only this file
 * before this change) and also held two capabilities the General/Experimental
 * split doesn't cover: `RepositoryCard` (default branch, manifest path,
 * GitHub collaborator invite) and `TriggersActivationCard` (the project-wide
 * "pause all triggers" switch). Rather than leave those two unreachable,
 * they moved (cut, not copied) to where a user would actually look for them:
 * `RepositoryCard` into `GitView` (`customize/sections/view/git-view.tsx`,
 * mounted at `case 'repositories'` below), `TriggersActivationCard` into
 * `ScheduleView` (`components/projects/schedule-view.tsx`, mounted at
 * `case 'schedules'`/`'webhooks'` below, rendered only on the Schedules
 * tab). With every piece of `SettingsView` rehomed, the file itself is
 * deleted. `snapshots` remains the only true placeholder tab.
 *
 * **Every pane must not fetch unless its tab is active** (see this file's
 * plan and `settings-panel.test.tsx`'s "real tab content gating" describe
 * block for the proof): `SettingsTabPane` renders `null` for every tab that
 * isn't the active one, so an inactive tab's real view is never even
 * instantiated as a React element — its hooks never run, so it can't fetch.
 * This is deliberate defense-in-depth: Radix's own `TabsContent` already
 * excludes an inactive pane's children from what it hands its wrapper div
 * (`present && children` in `@radix-ui/react-tabs`'s `TabsContent`, verified
 * directly against this repo's installed version — an inactive pane's
 * `<div role="tabpanel" hidden>` renders with NO children at all, not just
 * CSS-hidden ones), but gating explicitly in OUR OWN code means correctness
 * here never depends on a third-party internal staying the way it happens to
 * work today.
 */

import { ScheduleView } from '@/components/projects/schedule-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import { Label } from '@/components/ui/label';
import { Modal, ModalClose, ModalContent, ModalTitle } from '@/components/ui/modal';
import { SettingsSectionHeader } from '@/components/ui/settings-section-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Close } from '@/features/icon/icons/close';
import { MarketplaceView } from '@/features/marketplace/marketplace-view';
import { useReviewSessionSummary } from '@/features/review-center/hooks/use-review-session-summary';
import { detectManifestVersion } from '@/features/workspace/customize/migrate-to-v2/manifest-version';
import { UpgradesView } from '@/features/workspace/customize/migrate-to-v2/upgrade-view';
import { RelatedProjectsSwitcher } from '@/features/workspace/customize/related-projects-switcher';
import { LlmManagementView } from '@/features/workspace/customize/sections/gateway-view';
import { ChannelsView } from '@/features/workspace/customize/sections/view/channels-view';
import { CommandsView } from '@/features/workspace/customize/sections/view/commands-view';
import { ComputersView } from '@/features/workspace/customize/sections/view/computers-view';
import { GitView } from '@/features/workspace/customize/sections/view/git-view';
import { MembersView } from '@/features/workspace/customize/sections/view/members-view';
import { ReviewView } from '@/features/workspace/customize/sections/view/review-view';
import { SandboxView } from '@/features/workspace/customize/sections/view/sandbox-view';
import { SecretsView } from '@/features/workspace/customize/sections/view/secrets-view';
import { VoiceView } from '@/features/workspace/customize/sections/view/voice-view';
import { SettingsNavProvider, type SettingsNav } from '@/features/workspace/shared/settings-nav-context';
import { useIsMobile } from '@/hooks/utils';
import { isBillingEnabled } from '@/lib/config';
import { isLlmGatewayAvailable, isLlmGatewayEnabled } from '@/lib/llm-gateway';
import {
  CUSTOMIZE_SECTION_GATE_ACTIONS,
  isCustomizeSectionVisible,
  type CustomizeSection,
  type ProjectAction,
} from '@/lib/project-actions';
import { usePermissions } from '@/lib/use-permission';
import { useProjectCans } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import { hasOpenFloatingLayer, hasOpenNestedDialog } from '@/lib/z-stack';
import { useSettingsPanelStore, type MembersTab } from '@/stores/settings-panel-store';
import { getProjectDetail, type KortixProject } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { ArrowLeftIcon as ArrowLeft } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';
import { UPGRADE_ITEM, isRailItemActive, railGroups } from './rail';
import { DEFAULT_SETTINGS_TAB, type SettingsTab } from './settings-tabs';
import { ApiKeysTab } from './tabs/api-keys-tab';
import { AuditTab } from './tabs/audit-tab';
import { BillingTab } from './tabs/billing-tab';
import { ConnectedAccountsTab } from './tabs/connected-tab';
import { ExperimentalTab } from './tabs/experimental-tab';
import { GeneralTab } from './tabs/general-tab';
import { GroupsTab } from './tabs/groups-tab';
import { IdentityTab } from './tabs/identity-tab';
import { PreferencesTab } from './tabs/preferences-tab';
import { ProfileTab } from './tabs/profile-tab';
import { RolesTab } from './tabs/roles-tab';
import { UsageTab } from './tabs/usage-tab';
import type { RailGroup, RailItem } from './type';
import { useSettingsAccountId } from './use-settings-account-id';

/**
 * Maps a `SettingsTab` to the legacy `CustomizeSection` whose IAM read leaf
 * (`lib/project-actions.ts`) already gates it — reused as-is rather than
 * duplicated, since the leaves themselves didn't change, only the tab ids
 * that front them. Tabs with no entry here are either ungated (profile,
 * preferences, connected, snapshots, groups, experimental) or account-scoped
 * and gated through `ACCOUNT_TAB_PERMISSION` below instead — see that
 * constant's comment.
 */
const GATED_TAB_SECTION: Partial<Record<SettingsTab, CustomizeSection>> = {
  general: 'settings',
  members: 'members',
  secrets: 'secrets',
  channels: 'channels',
  repositories: 'git',
  schedules: 'schedules',
  webhooks: 'webhooks',
  models: 'llm-management',
  instructions: 'commands',
  sandbox: 'sandbox',
  marketplace: 'marketplace',
  review: 'review',
  voice: 'voice',
  computers: 'computers',
  upgrades: 'upgrade',
};

/**
 * **Task 13b.** The account-probe counterpart to `GATED_TAB_SECTION` above —
 * every account-scoped tab whose CONTAINER enforces a whole-tab permission
 * gate by returning `null` (`billing`'s `account.write` in
 * `tabs/billing-tab.tsx:377,450`, `usage`'s `account.write` in
 * `tabs/usage-tab.tsx:158,160`, `roles`'s `role.create` in
 * `tabs/roles-tab.tsx`). Before this task NONE of these three fed
 * `isTabAllowed` below, so a denied user still saw the rail row and clicked
 * into an empty pane — the defect this task fixes (see this task's brief,
 * `task-13b-brief.md`). `isTabAllowed` now consults this map exactly the way
 * it already consulted `GATED_TAB_SECTION`, so a denied account-scoped tab is
 * ABSENT from the rail instead of present-and-empty. The per-tab `return
 * null` in each container STAYS as a defensive backstop — this map changes
 * which rows the rail draws, not whether the containers still guard
 * themselves.
 *
 * `groups` is DELIBERATELY absent, matching the source page's `groups: true`
 * (`app/(app)/accounts/[id]/page.tsx:356`) exactly: it carries NO whole-tab
 * permission gate — every member reaches the pane. Only its CONTENT is
 * entitlement-gated (`EnterpriseUpsell` in place of the real view on a
 * non-`rbac` account, same as `roles`'s content once past its `role.create`
 * gate) — that is deliberate discoverability mirroring the server's `402`
 * from `requireEntitlement`, and must NOT become a hidden row. Permission
 * gating (this map) and entitlement gating (`EnterpriseUpsell`, handled
 * entirely inside `GroupsTab`/`RolesTab`) are different mechanisms and stay
 * different here — see `tabs/groups-tab.tsx`'s and `tabs/roles-tab.tsx`'s
 * header comments.
 *
 * **Task 14 update.** `identity` is wired to the real `IdentityTab` (see
 * `tabs/identity-tab.tsx`) and added below — same `account.write` whole-tab
 * gate as `billing`/`usage` (`app/(app)/accounts/[id]/page.tsx:358`), with
 * its own separate `!!(entitlements?.sso || entitlements?.scim)`
 * content-gate (an OR, not `rbac`) handled entirely inside `IdentityTab`,
 * same mechanism split as `groups`/`roles`.
 *
 * **Task 15 update.** `audit` is wired to the real `AuditTab` (see
 * `tabs/audit-tab.tsx`) and added below — its own `audit.read` whole-tab
 * gate (`app/(app)/accounts/[id]/page.tsx:363`), NOT `account.write` like
 * `billing`/`usage`/`identity`, with its own separate
 * `!!entitlements?.auditAccess` content-gate (`:309`) — its own leaf, NOT
 * `rbac` and NOT `sso || scim` — handled entirely inside `AuditTab`, same
 * mechanism split as `groups`/`roles`/`identity`.
 *
 * **Task 16 update.** `api-keys` is wired to the real `ApiKeysTab` (see
 * `tabs/api-keys-tab.tsx`) and added below — same `account.write` whole-tab
 * gate as `billing`/`usage`/`identity`
 * (`app/(app)/accounts/[id]/page.tsx:362 tokens: canWriteAccount === true`),
 * with no separate entitlement content-gate on top (see that file's header
 * comment for why `tokens` differs from `audit`/`identity` on this point).
 * No account-scoped tab is left as a placeholder after this task.
 */
export const ACCOUNT_TAB_PERMISSION: Partial<Record<SettingsTab, string>> = {
  billing: 'account.write',
  usage: 'account.write',
  roles: 'role.create',
  'api-keys': 'account.write',
  identity: 'account.write',
  audit: 'audit.read',
};

/** Distinct account actions to probe — one batched call over every
 *  `ACCOUNT_TAB_PERMISSION` entry, same shape as `CUSTOMIZE_SECTION_GATE_ACTIONS`
 *  for the project probe. Declared at module scope (not `useMemo`'d) so the
 *  probe list is a stable reference across renders without a dependency array —
 *  `usePermissions`'s query key includes it, and an unstable array would
 *  refetch every render. */
const ACCOUNT_TAB_GATE_ACTIONS: readonly string[] = Array.from(
  new Set(Object.values(ACCOUNT_TAB_PERMISSION)),
);
const ACCOUNT_TAB_PROBES = ACCOUNT_TAB_GATE_ACTIONS.map((action) => ({ action }));

/**
 * Whether `tab` is allowed to show in the rail — pure so it's unit-testable
 * with no hooks, no `QueryClientProvider`, no DOM (`bun test` has none of
 * those, see this file's `settings-panel.test.tsx`). Checks the project gate
 * (`GATED_TAB_SECTION`) first, then the account gate
 * (`ACCOUNT_TAB_PERMISSION`) — a tab is never in both, so this is an
 * if/else-shaped lookup, not a merge of two verdicts. A tab in neither map is
 * always allowed.
 *
 * **Both probes fail OPEN on "not yet resolved" — deliberately, including on
 * error, not just while loading.** This is a VISIBILITY layer, not a
 * security boundary: the API re-checks every mutation
 * (`require-billing-write.ts`, `role.create`'s own route guard, etc.), so the
 * worst case of failing open is a denied user briefly seeing a row that
 * 403s on click, exactly the UX `billing-tab.tsx`'s `canManageBilling` split
 * already accepts for its OWN mutating controls. Failing CLOSED instead — the
 * account probe's own `usePermission` default (`use-permission.ts:26-27`,
 * `false` while loading AND on error) — would blank rows on a slow or
 * transiently-erroring probe, which is strictly worse: it reads as "you lost
 * access" instead of "we're checking." That's why the caller below computes
 * `accountPermsResolved` itself (requiring `!isLoading && !isError` for every
 * probed action, PLUS a known account id) rather than reading
 * `usePermission`'s `allowed` directly — the same `isLoading`/`isError`
 * fields the hook already exposes are enough to tell "unresolved" apart from
 * "resolved to denied"; nothing about the hook needed to change.
 *
 * **The residual gap, stated plainly.** Once the rail fails open on an
 * ERRORED probe, the row is visible — but the TAB'S OWN container
 * (`BillingTabInner`, `UsageTabInner`, `RolesTabInner`) reads the exact same
 * action through plain `usePermission`, which fails CLOSED on that same
 * error (`allowed: false`), so the container still returns `null` on click.
 * A probe error therefore still produces a visible-row/empty-pane click in
 * this one narrow case — a real, much rarer instance of the original defect,
 * not a new one this task introduces. Fixing it fully would mean the
 * containers treating a probe error as "show an inline error", not "deny" —
 * out of scope here (it touches `usePermission`'s callers app-wide, not just
 * these three tabs) and reported as an open finding rather than silently
 * left unresolved.
 *
 * **Fix round 1 — `billing`'s deployment-flag gate, folded in.** The
 * reference model this task mirrors
 * (`app/(app)/accounts/[id]/page.tsx:359`) is `billing: canWriteAccount ===
 * true && billingActive` — the rail must reproduce BOTH terms, not just the
 * permission half. `isBillingEnabled()` (`lib/config.ts:78-80`,
 * `getEnv().BILLING_ENABLED`) is a synchronous env read with no loading/error
 * state, so it needs none of the fail-open machinery above — it is threaded
 * in as a plain `billingEnabled` boolean, checked FIRST and only for
 * `billing`, kept as its own `if` rather than folded into the account-gate
 * branch so the two concerns (a deployment flag vs. an IAM permission) stay
 * visibly separate. `usage` deliberately does NOT get this check — the
 * reference model's `transactions` line (`page.tsx:360`) is
 * `canWriteAccount === true` with no `billingActive` term, matching
 * `tabs/usage-tab.tsx`'s own header comment ("Deliberately NOT combined with
 * `isBillingEnabled()`... session costs stay available with billing off").
 */
export interface SettingsTabAllowedParams {
  projectCapsResolved: boolean;
  projectCan: (action: ProjectAction) => boolean;
  accountPermsResolved: boolean;
  accountCan: (action: string) => boolean;
  /** Deployment flag, not a permission — `isBillingEnabled()`
   *  (`lib/config.ts`). Only `billing` consults this; every other tab
   *  ignores it. See this function's header comment, "Fix round 1". */
  billingEnabled: boolean;
}

export function isSettingsTabAllowed(tab: SettingsTab, params: SettingsTabAllowedParams): boolean {
  // Deployment-flag gate — a separate axis from permission, checked first
  // and only for `billing`. See this function's header comment, "Fix round 1".
  if (tab === 'billing' && !params.billingEnabled) return false;

  const section = GATED_TAB_SECTION[tab];
  if (section) {
    if (!params.projectCapsResolved) return true;
    return isCustomizeSectionVisible(section, params.projectCan);
  }
  const accountAction = ACCOUNT_TAB_PERMISSION[tab];
  if (accountAction) {
    if (!params.accountPermsResolved) return true;
    return params.accountCan(accountAction);
  }
  return true;
}

/**
 * Adapts `useSettingsPanelStore`'s state into the panel-agnostic
 * `SettingsNav` shape the five `customize/sections/**` views will read once
 * they're mounted here (Task 5b/later) — see `settings-nav-context.tsx`'s
 * header. Nothing under this panel consumes it yet: no tab-pane content is
 * wired up (see this file's top comment), so `<SettingsNavProvider>` below
 * currently has no `useSettingsNav()` descendants. It's wired up now so a
 * later task that mounts real content doesn't also have to remember to add
 * the provider.
 *
 * `llmProvidersTab` has no equivalent field on this store (Task 4's finding,
 * documented on `settings-panel-store.ts`), so it's always `undefined` here.
 * Exported for a pure unit test; no rendering required.
 */
export function buildSettingsPanelSettingsNav(state: {
  open: boolean;
  tab: SettingsTab;
  membersTab: MembersTab;
}): SettingsNav {
  return {
    activeTab: state.tab,
    isOpen: state.open,
    membersTab: state.membersTab,
    llmProvidersTab: undefined,
    navigate: (tab, opts) => {
      useSettingsPanelStore.getState().setTab(tab as SettingsTab);
      if (opts?.membersTab) {
        useSettingsPanelStore.setState({ membersTab: opts.membersTab as MembersTab });
      }
    },
  };
}

export function SettingsPanel({ projectId }: { projectId?: string }) {
  const open = useSettingsPanelStore((s) => s.open);
  const tab = useSettingsPanelStore((s) => s.tab);
  const setTab = useSettingsPanelStore((s) => s.setTab);
  const close = useSettingsPanelStore((s) => s.close);
  // Reactive (not getState()) so it re-renders this provider — and every
  // useSettingsNav() consumer — when membersTab changes, e.g. a deep link
  // opening straight to Invite.
  const membersTab = useSettingsPanelStore((s) => s.membersTab);
  const settingsNav = useMemo(
    () => buildSettingsPanelSettingsNav({ open, tab, membersTab }),
    [open, tab, membersTab],
  );
  const isMobile = useIsMobile();

  const detail = useQuery({
    queryKey: qk.project.detail(projectId ?? ''),
    queryFn: () => getProjectDetail(projectId!),
    enabled: open && !!projectId,
    ...contract('config'),
  });
  const project = projectId ? detail.data?.project : undefined;

  // IAM visibility gating. One batched probe over every gated tab's read leaf
  // — a custom role that OMITS a leaf (e.g. project.gitops.read) makes that
  // tab disappear from the rail and blocks its content. NOT a security
  // boundary (the API re-checks every mutation); this only decides what to
  // show. Feed the accountId we ALREADY hold from the project-detail query so
  // the probe runs on first render rather than being disabled while a
  // separate getProject resolves.
  const caps = useProjectCans(open ? projectId : undefined, CUSTOMIZE_SECTION_GATE_ACTIONS, {
    accountId: project?.account_id,
  });
  // Treat BOTH "loading" and "errored" as not-yet-resolved — this is a VISIBILITY
  // layer, not a security boundary, so we fail OPEN (render the full rail) rather
  // than blank the UI on a transient probe failure or while it's in flight.
  const capsResolved = useMemo(
    () =>
      CUSTOMIZE_SECTION_GATE_ACTIONS.every(
        (action) => caps[action] && !caps[action].isLoading && !caps[action].isError,
      ),
    [caps],
  );

  // Task 13b — the ACCOUNT-scoped counterpart of the probe above, for
  // `ACCOUNT_TAB_PERMISSION` (`billing`/`usage`/`roles` today). Same accountId
  // resolution every account-scoped tab container uses
  // (`useSettingsAccountId` — project's account wins, falling back to the
  // app-wide selected account), so this probe agrees with what
  // `BillingTabInner`/`UsageTabInner`/`RolesTabInner` will themselves resolve
  // — a mismatch here would make the rail show/hide a row the container then
  // disagrees with.
  const resolvedAccountId = useSettingsAccountId(project?.account_id);
  // Only fire while the panel is open AND an account id is actually known —
  // `usePermissions` reports a DISABLED query as `isLoading: false` in
  // react-query v5 (no fetch in flight), so without this guard an unresolved
  // accountId would read as "resolved, denied" instead of "not yet known".
  // Same footgun `use-project-can.ts`'s `pendingWhileUnresolved` documents
  // for the identical race on the project probe.
  const accountProbeReady = open && !!resolvedAccountId;
  const accountPerms = usePermissions(
    accountProbeReady ? resolvedAccountId : undefined,
    ACCOUNT_TAB_PROBES,
  );
  // Same fail-open contract as `capsResolved` above: resolved only once every
  // probed action has settled with neither `isLoading` nor `isError` — a
  // failed probe stays "unresolved" (renders the row) rather than "resolved
  // denied" (hides it). See `isSettingsTabAllowed`'s header comment for why.
  const accountPermsResolved = useMemo(
    () => accountProbeReady && accountPerms.every((p) => !p.isLoading && !p.isError),
    [accountProbeReady, accountPerms],
  );
  const accountCan = useCallback(
    (action: string) => {
      const idx = ACCOUNT_TAB_GATE_ACTIONS.indexOf(action);
      return idx >= 0 && accountPerms[idx]?.allowed === true;
    },
    [accountPerms],
  );

  // Deployment flag, not a permission — see `isSettingsTabAllowed`'s header
  // comment, "Fix round 1". Synchronous env read, so no memo needed.
  const billingEnabled = isBillingEnabled();

  // A tab is permitted when its READ leaf (project-scoped) or its whole-tab
  // permission (account-scoped) resolved to allowed:true — a role that can
  // read a tab SEES it (read-only unless it also holds the write leaf; edit
  // controls inside each pane gate on can_manage separately). Until a probe
  // resolves (or if it errored) we permit everything it gates (optimistic) —
  // visibility, not security. Tabs gated by neither map are always permitted.
  const isTabAllowed = useCallback(
    (t: SettingsTab) =>
      isSettingsTabAllowed(t, {
        projectCapsResolved: capsResolved,
        projectCan: (action) => caps[action]?.allowed === true,
        accountPermsResolved,
        accountCan,
        billingEnabled,
      }),
    [caps, capsResolved, accountPermsResolved, accountCan, billingEnabled],
  );

  const tunnelEnabled = project?.experimental?.agent_tunnel ?? false;
  const marketplaceEnabled = project?.experimental?.marketplace ?? false;
  const llmGatewayAvailable = isLlmGatewayAvailable(project);
  // Distinct from `llmGatewayAvailable` above (which only affects rail
  // visibility, per `rail.ts`'s comment — the Models row always shows).
  // `llmGatewayEnabled` gates the Models tab's actual CONTENT, mirroring
  // the legacy panel's `if (section.startsWith('llm-') &&
  // !llmGatewayEnabled) return null;` exactly.
  const llmGatewayEnabled = isLlmGatewayEnabled(project);
  const voiceEnabled = project?.experimental?.voice ?? false;
  const reviewEnabled = project?.experimental?.review_center ?? false;
  // Pin Upgrades' attention dot only once the manifest read resolved to v1 —
  // while the detail query is in flight (or on v2 projects) the dot stays off.
  const upgradeAttention = detail.data
    ? detectManifestVersion(detail.data.config.manifest_raw) === 1
    : false;

  // "Needs you" count for the Review rail badge — the SAME shared inbox summary the
  // sidebar "Review" pill and the per-session row dots read (one query key, one
  // derivation), so the badge, the pill, and the dots can never drift apart.
  const reviewNeedsYou = useReviewSessionSummary(projectId ?? '', {
    enabled: open && reviewEnabled,
  }).totalNeedsYou;

  const groups = useMemo(
    // Compose flag-gating with IAM visibility: an item shows only if it passes
    // BOTH its flag check (baked into railGroups) AND its read-leaf probe. Empty
    // groups drop out so no orphan header renders.
    () =>
      railGroups({
        tunnelEnabled,
        marketplaceEnabled,
        llmGatewayAvailable,
        voiceEnabled,
        reviewEnabled,
      })
        .map((g) => ({ ...g, items: g.items.filter((item) => isTabAllowed(item.tab)) }))
        .filter((g) => g.items.length > 0),
    [tunnelEnabled, marketplaceEnabled, llmGatewayAvailable, voiceEnabled, reviewEnabled, isTabAllowed],
  );
  // Upgrades lives in its own pinned footer, but stays in the item universe so
  // deep-links, the mobile tail, and the active-tab fallback all still see it.
  const upgradeAllowed = isTabAllowed('upgrades');
  const allItems = useMemo(
    () => [...groups.flatMap((g) => g.items), ...(upgradeAllowed ? [UPGRADE_ITEM] : [])],
    [groups, upgradeAllowed],
  );
  const tabVisible = allItems.some((item) => isRailItemActive(item, tab));

  useEffect(() => {
    if (open && !tabVisible) {
      setTab(DEFAULT_SETTINGS_TAB);
    }
  }, [open, tabVisible, setTab]);

  // If the active tab is denied once its probe resolves (e.g. a bookmarked
  // deep-link into a tab this role no longer grants), fall back to the first
  // permitted tab. Only after the RELEVANT probe resolves — never during the
  // loading/optimistic window, or we'd clobber a valid deep-link. No explicit
  // `capsResolved`/`accountPermsResolved` check needed here: `isTabAllowed`
  // (via `isSettingsTabAllowed`) already fails open per-tab while ITS OWN
  // gating probe (project or account, whichever applies) is unresolved, so
  // `activeAllowed` alone already carries that signal for both probe kinds.
  const activeAllowed = isTabAllowed(tab);
  useEffect(() => {
    if (!open || activeAllowed) return;
    const fallback = allItems[0]?.tab ?? DEFAULT_SETTINGS_TAB;
    if (fallback !== tab) setTab(fallback);
  }, [open, activeAllowed, allItems, tab, setTab]);

  return (
    <SettingsNavProvider value={settingsNav}>
      <SettingsPanelView
        open={open}
        tab={tab}
        onTabChange={setTab}
        onOpenChange={(next) => (next ? undefined : close())}
        isMobile={isMobile}
        project={project}
        projectId={projectId}
        accountId={project?.account_id}
        groups={groups}
        allItems={allItems}
        upgradeAllowed={upgradeAllowed}
        upgradeAttention={upgradeAttention}
        reviewNeedsYou={reviewNeedsYou}
        llmGatewayEnabled={llmGatewayEnabled}
      />
    </SettingsNavProvider>
  );
}

export interface SettingsPanelViewProps {
  open: boolean;
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  onOpenChange: (open: boolean) => void;
  isMobile: boolean;
  project: KortixProject | undefined;
  /** Threaded independently of `project` (the detail query's RESULT) so a
   *  tab's real view gets a stable id from the first render — it doesn't need
   *  to wait on `project` to resolve, since every real view does its own
   *  loading/skeleton handling once mounted. */
  projectId: string | undefined;
  /** The project's owning account — threaded the same way as `projectId`
   *  (independently of `project` resolving) for the one tab that needs it:
   *  `connected`'s GitHub row is account-scoped, not project-scoped (see
   *  `tabs/connected-tab.tsx`). */
  accountId: string | undefined;
  groups: readonly RailGroup[];
  allItems: readonly RailItem[];
  upgradeAllowed: boolean;
  upgradeAttention: boolean;
  reviewNeedsYou: number;
  /** Gates the Models tab's CONTENT (not its rail visibility — see
   *  `SettingsPanel`'s comment next to where this is computed). */
  llmGatewayEnabled: boolean;
}

/** Presentational only — no hooks, no data fetching, no store read. Kept
 *  separate from `SettingsPanel` so the shell renders under
 *  `renderToStaticMarkup` without a `QueryClientProvider`, router, or mounted
 *  Zustand store — see `MigrateToV2ButtonView` for the same split.
 *
 *  NOT itself renderable via `renderToStaticMarkup`: `ModalContent` renders
 *  through `DialogPrimitive.Portal`, which gates on a `mounted` state flipped
 *  by `useLayoutEffect` — that effect never runs during static rendering, so
 *  the portal (and everything inside it) always renders as nothing,
 *  independent of `open`. `SettingsPanelShell` below holds everything BELOW
 *  the portal boundary and is what the test file actually exercises. */
export function SettingsPanelView({
  open,
  tab,
  onTabChange,
  onOpenChange,
  isMobile,
  project,
  projectId,
  accountId,
  groups,
  allItems,
  upgradeAllowed,
  upgradeAttention,
  reviewNeedsYou,
  llmGatewayEnabled,
}: SettingsPanelViewProps) {
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent
        animation="none"
        showCloseButton={false}
        closeOnOutsideClick={false}
        variant="base"
        aria-describedby={undefined}
        onEscapeKeyDown={(event) => {
          if (hasOpenFloatingLayer() || hasOpenNestedDialog()) {
            event.preventDefault();
          }
        }}
        className={cn(
          'flex flex-col gap-0 overflow-hidden p-0',
          'inset-0 top-0 left-0 h-dvh min-h-dvh w-screen max-w-none translate-x-0 translate-y-0 space-y-0 rounded-none border-0 shadow-none sm:max-w-none sm:rounded-none md:rounded-none lg:top-0 lg:left-0 lg:h-dvh lg:min-h-dvh lg:max-w-none lg:translate-x-0 lg:translate-y-0 lg:rounded-none',
        )}
      >
        <ModalTitle className="sr-only">{project ? `Settings — ${project.name}` : 'Settings'}</ModalTitle>

        <SettingsPanelShell
          tab={tab}
          onTabChange={onTabChange}
          isMobile={isMobile}
          project={project}
          projectId={projectId}
          accountId={accountId}
          groups={groups}
          allItems={allItems}
          upgradeAllowed={upgradeAllowed}
          upgradeAttention={upgradeAttention}
          reviewNeedsYou={reviewNeedsYou}
          llmGatewayEnabled={llmGatewayEnabled}
        />
      </ModalContent>
    </Modal>
  );
}

export type SettingsPanelShellProps = Omit<
  SettingsPanelViewProps,
  'open' | 'onOpenChange'
>;

/** Everything the modal shows once it's open, MINUS the modal chrome itself
 *  (`Modal` / `ModalContent` / the portal). Split out purely so this can
 *  render under `renderToStaticMarkup` — see the note on `SettingsPanelView`
 *  above for why the portal boundary has to sit above this component, not
 *  inside it. */
export function SettingsPanelShell({
  tab,
  onTabChange,
  isMobile,
  project,
  projectId,
  accountId,
  groups,
  allItems,
  upgradeAllowed,
  upgradeAttention,
  reviewNeedsYou,
  llmGatewayEnabled,
}: SettingsPanelShellProps) {
  return (
    <>
      {/* Desktop shell: this modal is `inset-0`, so its first row starts at
          the window's top-left — under the macOS traffic lights, and under
          the Win/Linux control cluster. The rail's "Back to workspace"
          button landed straight on the lights.

          A `.kx-titlebar-spacer` (display:none on the web, band-height and
          draggable on desktop) drops the WHOLE modal below the band, which
          covers the narrow-window variant too — the old guard was a
          left-only `.kx-customize-header` indent that only ever fixed the
          wide layout, and whose class stopped being rendered when this
          became a two-column grid. */}
      <div className="kx-titlebar-spacer shrink-0" />

      <Tabs
        value={tab}
        onValueChange={(next) => onTabChange(next as SettingsTab)}
        orientation="vertical"
        className={cn('min-h-0 flex-1 gap-0', isMobile ? 'flex flex-col' : 'grid grid-cols-[250px_1fr]')}
      >
        {isMobile ? (
          <nav
            aria-label="Settings"
            className="border-border/60 bg-background flex h-auto shrink-0 items-center border-b"
          >
            <FadedScrollArea
              orientation="horizontal"
              fadeColor="from-background"
              className="min-w-0 flex-1 py-2"
            >
              <TabsList orientation="horizontal" className="w-fit gap-1 px-2">
                {allItems.map((item) => (
                  <TabsTrigger
                    key={item.tab}
                    value={item.tab}
                    className="w-auto shrink-0 gap-2.5 px-3 whitespace-nowrap"
                  >
                    <RailTriggerBody
                      item={item}
                      count={item.tab === 'review' ? reviewNeedsYou : undefined}
                      attention={item.tab === 'upgrades' && upgradeAttention}
                      horizontal
                    />
                  </TabsTrigger>
                ))}
              </TabsList>
            </FadedScrollArea>
            <div className="flex shrink-0 items-center px-4">
              <ModalClose asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground shrink-0"
                  aria-label="Close"
                >
                  <Close className="text-foreground size-4 stroke-1" />
                </Button>
              </ModalClose>
            </div>
          </nav>
        ) : (
          <section className="bg-sidebar flex min-h-0 flex-col border-r py-4">
            <div className="w-full shrink-0 px-2.5">
              <ModalClose asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground flex w-full items-center justify-start gap-2 px-4 py-2 text-left text-sm font-medium"
                >
                  <ArrowLeft />
                  Back to workspace
                </Button>
              </ModalClose>
            </div>

            {project ? <RelatedProjectsSwitcher project={project} /> : null}

            <nav
              aria-label="Settings"
              className="mt-4 min-h-0 flex-1 [scrollbar-width:none] overflow-y-auto px-2.5 py-3 [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
            >
              {groups.map((group, idx) => (
                <div key={group.label} className={cn('space-y-1', idx > 0 ? 'mt-4' : undefined)}>
                  <Label className="text-muted-foreground px-2 pb-1">{group.label}</Label>
                  {/* Radix's `TabsList` can only contain trigger children —
                      the group `Label` above can't live inside it, so each
                      group gets its OWN list rather than one list for the
                      whole rail. Trade-off: arrow-key roving moves within a
                      group, not across the whole rail (see the task report). */}
                  <TabsList orientation="vertical">
                    {group.items.map((item) => (
                      <TabsTrigger key={item.tab} value={item.tab} className="gap-2.5">
                        <RailTriggerBody
                          item={item}
                          count={item.tab === 'review' ? reviewNeedsYou : undefined}
                        />
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </div>
              ))}
            </nav>

            {/* Upgrades pinned to the extreme bottom of the rail, below the
                scrolling nav. Carries an attention dot on a v1 manifest. Its
                own single-item TabsList for the same Radix reason as above. */}
            {upgradeAllowed && (
              <div className="mt-2 shrink-0 px-2.5 pt-3">
                <TabsList orientation="vertical">
                  <TabsTrigger value={UPGRADE_ITEM.tab} className="gap-2.5">
                    <RailTriggerBody item={UPGRADE_ITEM} attention={upgradeAttention} />
                  </TabsTrigger>
                </TabsList>
              </div>
            )}
          </section>
        )}

        <main className="bg-background flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {allItems.map((item) => (
            <TabsContent
              key={item.tab}
              value={item.tab}
              className="flex min-h-0 flex-1 flex-col overflow-y-auto"
            >
              <SettingsTabPane
                item={item}
                active={item.tab === tab}
                projectId={projectId}
                accountId={accountId}
                llmGatewayEnabled={llmGatewayEnabled}
              />
            </TabsContent>
          ))}
        </main>
      </Tabs>
    </>
  );
}

/**
 * Real view for one tab, gated on `active` so its hooks (and any fetch they
 * start) only ever run for the tab currently selected — see this file's
 * header comment and `settings-panel.test.tsx`'s "real tab content gating"
 * describe block for why this is explicit rather than left to Radix's own
 * `TabsContent` behaviour.
 *
 * `profile`, `preferences`, `connected` (Task 9), `billing` (Task 11),
 * `usage` (Task 12), `groups`/`roles` (Task 13), `identity` (Task 14),
 * `audit` (Task 15), and `api-keys` (Task 16) are handled above the switch
 * (account-scoped, no `projectId` needed). The switch below is the Task 5b2
 * mapping of the legacy panel's `SectionContent` (14 `case` labels + the
 * `llm-*` prefix branch) onto the new tab ids, PLUS `general` (rewired, Task
 * 18) and `experimental` (newly wired, Task 18) — see this file's header
 * comment. A tab NOT listed here or above — `snapshots` — is a genuinely new
 * surface with no legacy source to port; it keeps the placeholder header
 * until a later phase builds it. `snapshots` is HALF of the legacy `sandbox`
 * case (`SandboxView` renders templates and the build log together);
 * splitting them is a later task, so `sandbox` alone gets the full unsplit
 * view for now and `snapshots` stays a placeholder — do not fold
 * `SandboxView` onto both tabs, that would render the build log twice.
 */
function SettingsTabPane({
  item,
  active,
  projectId,
  accountId,
  llmGatewayEnabled,
}: {
  item: RailItem;
  active: boolean;
  projectId: string | undefined;
  accountId: string | undefined;
  llmGatewayEnabled: boolean;
}) {
  if (!active) return null;

  // Account-scoped — renders with no dependency on the current project, so
  // it works even while no project is selected (unlike every case below).
  if (item.tab === 'profile') {
    return <ProfileTab />;
  }
  if (item.tab === 'preferences') {
    return <PreferencesTab />;
  }
  // Same no-`projectId`-required shape as `profile`/`preferences`, but it
  // ALSO reads `accountId` — its GitHub row is account-scoped, not
  // project-scoped (see `tabs/connected-tab.tsx`'s header comment).
  if (item.tab === 'connected') {
    return <ConnectedAccountsTab projectId={projectId} accountId={accountId} />;
  }
  // Same no-`projectId`-required, `accountId`-reading shape as `connected`
  // above — see `tabs/billing-tab.tsx`'s header comment. Renders nothing at
  // all without `billing.write` on the resolved account and
  // `isBillingEnabled()`.
  if (item.tab === 'billing') {
    return <BillingTab accountId={accountId} />;
  }
  // Same no-`projectId`-required, `accountId`-reading shape as `billing`
  // above — see `tabs/usage-tab.tsx`'s header comment. Renders nothing at
  // all without `account.write` on the resolved account; unlike `billing`,
  // does NOT also require `isBillingEnabled()`.
  if (item.tab === 'usage') {
    return <UsageTab accountId={accountId} />;
  }
  // Same no-`projectId`-required, `accountId`-reading shape as `billing`/
  // `usage` above — see `tabs/groups-tab.tsx`'s header comment. Groups has
  // no whole-tab permission gate (every member reaches the pane); only its
  // CONTENT is entitlement-gated.
  if (item.tab === 'groups') {
    return <GroupsTab accountId={accountId} />;
  }
  // Same shape as `groups` above, but ALSO renders nothing at all without
  // `role.create` on the resolved account — see `tabs/roles-tab.tsx`'s
  // header comment for why that whole-tab gate lives in the container
  // rather than here.
  if (item.tab === 'roles') {
    return <RolesTab accountId={accountId} />;
  }
  // Same shape as `billing`/`usage` above — see `tabs/identity-tab.tsx`'s
  // header comment. Renders nothing at all without `account.write` on the
  // resolved account; its content separately gates on the `sso`/`scim`
  // entitlement OR (not `rbac`).
  if (item.tab === 'identity') {
    return <IdentityTab accountId={accountId} />;
  }
  // Same shape as `billing`/`usage`/`identity` above — see
  // `tabs/audit-tab.tsx`'s header comment. Renders nothing at all without
  // `audit.read` on the resolved account (NOT `account.write`); its content
  // separately gates on the `auditAccess` entitlement (its own leaf, not
  // `rbac` and not `sso`/`scim`).
  if (item.tab === 'audit') {
    return <AuditTab accountId={accountId} />;
  }
  // Same shape as `billing`/`usage`/`identity` above — see
  // `tabs/api-keys-tab.tsx`'s header comment. Renders nothing at all
  // without `account.write` on the resolved account; unlike `audit`/
  // `identity`, its content has no separate entitlement gate on top.
  if (item.tab === 'api-keys') {
    return <ApiKeysTab accountId={accountId} />;
  }

  if (projectId) {
    switch (item.tab) {
      case 'general':
        return <GeneralTab projectId={projectId} />;
      case 'experimental':
        return <ExperimentalTab projectId={projectId} />;
      case 'members':
        return <MembersView projectId={projectId} />;
      case 'secrets':
        return <SecretsView projectId={projectId} />;
      case 'channels':
        return <ChannelsView projectId={projectId} />;
      case 'repositories':
        return <GitView projectId={projectId} />;
      case 'schedules':
        return <ScheduleView projectId={projectId} type="cron" />;
      case 'webhooks':
        return <ScheduleView projectId={projectId} type="webhook" />;
      case 'computers':
        return <ComputersView projectId={projectId} />;
      case 'models':
        // Mirrors the legacy panel's
        // `if (section.startsWith('llm-') && !llmGatewayEnabled) return null;`
        // — renders nothing (not the placeholder) while disabled.
        return llmGatewayEnabled ? <LlmManagementView projectId={projectId} /> : null;
      case 'instructions':
        return <CommandsView projectId={projectId} />;
      case 'marketplace':
        return <MarketplaceView projectId={projectId} />;
      case 'review':
        return <ReviewView projectId={projectId} />;
      case 'voice':
        return <VoiceView projectId={projectId} />;
      case 'sandbox':
        return <SandboxView projectId={projectId} />;
      case 'upgrades':
        return <UpgradesView projectId={projectId} />;
      default:
        break;
    }
  }

  // No project id (an account-scoped open with no workspace selected yet) or
  // a tab with no real view wired up yet — same placeholder either way.
  return (
    <div className="p-6">
      <SettingsSectionHeader title={item.label} />
    </div>
  );
}

function RailTriggerBody({
  item,
  count,
  attention,
  horizontal = false,
}: {
  item: RailItem;
  /** Optional attention count shown as a pill (e.g. review items needing you). */
  count?: number;
  /** A quiet dot for a pending nudge with no count (e.g. an available upgrade). */
  attention?: boolean;
  horizontal?: boolean;
}) {
  const Icon = item.icon;
  const showCount = count != null && count > 0;
  return (
    <>
      {Icon && <Icon className="size-4 shrink-0" />}
      <span className={cn(!horizontal && 'truncate')}>{item.label}</span>
      {showCount ? (
        <Badge variant="kortix" size="xs" className={cn('tabular-nums', !horizontal && 'ml-auto')}>
          {count}
        </Badge>
      ) : attention ? (
        <span
          aria-hidden
          className={cn('bg-kortix-orange size-1.5 shrink-0 rounded-full', !horizontal && 'ml-auto')}
        />
      ) : null}
    </>
  );
}
