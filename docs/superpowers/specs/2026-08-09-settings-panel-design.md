# Settings panel design

## Status

Approved by the user on 2026-08-09, after three rounds of review.

Tracked in Linear as the **Settings panel** project on team Jay:
https://linear.app/sutharjay/project/settings-panel-6323b30fb099

Branch `settings`, worktree `/Users/jay/root/kortix/suna-settings`. The user
directed that no new worktree be created.

Implementation target: `apps/web/src/features/workspace/customize/` (renamed),
`apps/web/src/features/accounts/settings/`, and the deletion of
`apps/web/src/app/(app)/accounts/`.

## Problem

Kortix has three separate settings surfaces. They hold overlapping content, use
three different shells, and none of them uses the `Tabs` primitive.

| Surface | File | Lines | Shell | Scope |
| --- | --- | --- | --- | --- |
| Customize overlay | `features/workspace/customize/customize-panel.tsx` | 424 | full-screen `Modal`, hand-rolled 250px rail | project |
| User settings modal | `features/accounts/settings/side-panel-user-settings.tsx` | 276 | `max-w-4xl` `Modal`, 12-column grid | user |
| Account page | `app/(app)/accounts/[id]/page.tsx` | 2378 | route + hand-rolled left rail | account |

Four concrete defects follow from this split.

1. **No shared tab primitive.** All three render a rail of
   `<Button variant={active ? … : 'ghost'}>` and a `switch` on the active id.
   Each has its own active-styling rule, its own group-header treatment, and its
   own header block. Each rail button is a separate tab stop; none has roving
   focus, `aria-controls`, or `aria-labelledby`.
2. **Three header styles.** `CustomizeSectionWrapper` renders
   `text-xl font-medium` with a `text-sm text-muted-foreground` subtitle. The
   account page uses `PANE_META` with a different block. The user modal uses
   `ModalHeader` / `ModalTitle` / `ModalDescription`. The same idea is written
   three times.
3. **Billing is not where settings are.** Plan, credit ledger, and every
   enterprise IAM surface live at `/accounts/[id]?tab=…`, which is a different
   page reached by a full document navigation
   (`stores/account-settings-modal-store.ts` sets `window.location.href`).
4. **Provider connect is 3,206 lines across 11 files.**
   `features/providers/connect-provider-content.tsx` alone is 1,076. Connecting
   an Anthropic key — the single most common action a new user takes — is
   behind a modal, an accordion, and a search field.

## Evidence

### Mobbin, closest product analogues

Cursor is the nearest analogue to Kortix on Mobbin: an agent product with
projects, models, members, and metered spend, whose settings carry exactly the
scope mix this panel has to solve.

- [Cursor › Settings](https://mobbin.com/screens/064c9294-fb84-4fe2-a665-e90b17fc4b77)
  — the account chip (name + plan) sits at the **top of the rail**, which is the
  slot this spec gives the scope switcher. Personal and organization rows share
  one rail, separated by a divider rather than by moving to another page. The
  pane is a stack of sections (Privacy / Profile / Appearance / Active Sessions),
  each row carrying label and description on the left and one control on the
  right. Theme is a right-aligned `System ⌄` select; each Active Session row
  carries a `Revoke` button.
- [Cursor › Integrations](https://mobbin.com/screens/e6afde3a-ca5e-413f-8460-015397bf1d00)
  — **the single most directly applicable screen.** GitHub, GitLab, Slack, and
  Linear each render as one row: logo, name, one-line status, and exactly one
  right-aligned button (`Manage ⌄` when connected, `Connect ↗` when not). This is
  the Connected accounts contract. Below it, User API Keys renders as a
  **table** — Name, Token, Scope, Created, and a remove control — with a
  `New User API Key` action above it. That is the API keys contract, including
  the Scope column.
- [Cursor › Spending](https://mobbin.com/screens/32551509-499c-4cdb-9002-a850b00bca24)
  — current plan and upgrade offer as two side-by-side cards, then a usage meter,
  then an on-demand limit row with an inline `Fixed ⌄ / 5 / Save` control. The
  Billing and Usage pattern.
- [Cursor › Members](https://mobbin.com/screens/afe31ac4-711d-428d-b21b-3a8075c5a0ac)
  — the not-yet-entitled state. A feature grid plus "Need enterprise features?
  Get pooled usage, SCIM seat management, and granular admin controls
  [Contact sales]". This is the `EnterpriseUpsell` behaviour this spec keeps for
  non-entitled accounts.
- [Cursor › GitHub app](https://mobbin.com/screens/01bc9bde-3eb5-41d1-b143-83fc0e0f8081)
  — GitHub's own installation page for the Cursor app: permissions, repository
  access, danger zone. Corroborates that a GitHub app install is an
  account/organization object, not a personal login link. See the scope conflict
  flagged under You › Connected accounts.

### Mobbin, rail structure at this density

**Tembo is not on Mobbin.** A targeted search returned no Tembo screens. The
references below answer the same question — how a rail of this size is grouped —
and are cited in its place rather than inventing a link.

- [Sentry](https://mobbin.com/screens/890b184a-c629-481a-b975-df0e4749e450) —
  the closest structural match to the IA in this spec, arrived at independently.
  Its rail is grouped **Account** (Account Details, Security, Notifications,
  Email Addresses, Subscriptions, Authorized Applications, Identities, Close
  Account), **Organization** (General Settings, Stats & Usage, Projects, Teams,
  Members, Security & Privacy, Auth, Audit Log, Relay, Repositories,
  Integrations, Feature Flags), and **Developer Settings** (Organization Tokens).
  That is roughly 25 rows in one rail with collapsible group headers, which
  answers risk 4 — a rail this long is workable when grouped. A breadcrumb
  (`Settings / Account / Details`) sits above the pane.
- [Lovable](https://mobbin.com/screens/0e11570a-2d0b-40a0-a7ca-e75aa2f38cab) —
  settings as a **modal overlay**, which is the shell this spec keeps. Grouped
  **Workspace** / **Account** / **Connectors**, with GitHub under Connectors as
  its own group rather than under Account. Rows mix toggle, radio group, and
  button controls under one label-and-description shape, and Delete account is a
  right-aligned destructive button on that same shape.
- [Magnific](https://mobbin.com/screens/23106449-1ff8-48cf-a9ce-5e37b21ef503) —
  grouped **Account** (Profile, …) and **Organization** (My Team, People, MCP,
  Security SSO, Preferences, Plan & billing), with a `Settings / Profile`
  breadcrumb.
- [Supabase](https://mobbin.com/screens/f8b66d48-cda0-49d1-8979-3dbffad3d28c) —
  grouped Projects / Organizations / Account / Documentation, with Logout pinned
  to the bottom of the rail.

### Mobbin, section and header patterns

- [Ghost](https://mobbin.com/screens/7329b9a8-f2f4-4e08-95a2-2ddb72b1df3f) —
  uppercase group labels in the rail (SITE / MEMBERSHIP / EMAIL NEWSLETTER /
  ADVANCED). Content is a stack of blocks, each carrying title, description, and
  one right-aligned action. This is the block the user specified.
- [Framer](https://mobbin.com/screens/cd5de83c-ee9e-4467-aad4-121427f9b9cf) —
  two rail groups with per-row icons. Its Danger Zone row uses the same
  title/description/action shape with a destructive button, so one row primitive
  covers destructive actions.
- [Revolut Business](https://mobbin.com/screens/14dedbb5-61cc-4ef0-895d-a75d7a92767e)
  — full-screen settings overlay with a close control and an icon rail. This is
  the shell Kortix already has.
- [Squarespace](https://mobbin.com/screens/0cb9a5e6-72e1-4cc8-a214-93c4a65a6c10)
  — breadcrumb above the pane title (`Selling › Business Information`).
- [Google Drive](https://mobbin.com/screens/c026c57c-8eba-4d55-b68f-d99ebc4416f3)
  — plain text rail with no icons, proving icons are optional at this density.

### Codebase facts established by reading

- `apps/api/src/projects/routes/r6.ts:240` — `GET /projects/:id/access` selects
  `.from(accountMembers).where(eq(accountMembers.accountId, …))` for the whole
  account, then left-joins project grants and group grants. Every account member
  is returned, carrying `account_role`, `project_role`,
  `effective_project_role`, `effective_source`, and `group_sources`.
- `lib/customize-sections.ts:11-16` — Files, Agents, Connectors, and Skills were
  deliberately moved out of this overlay to standalone routes with their own read
  leaves. Commands moved back in after its standalone page was deleted (#6169).
- `features/workspace/customize/rail.ts:110` — `railGroups` must accumulate all
  optional items in one pass. An early `return` on the first matching flag made
  Review unreachable, because `marketplaceEnabled` is on for effectively every
  project and always matched first.
- `customize-panel.tsx:62-87` — rail visibility runs one batched
  `useProjectCans` probe over `CUSTOMIZE_SECTION_GATE_ACTIONS` and fails **open**:
  both loading and errored states render the full rail. This is a visibility
  layer, not a security boundary; the API re-checks every mutation.
- `components/ui/tabs.tsx` — horizontal only. `tabsListHeightClasses`,
  `tabsTriggerPaddingVariants`, and `SlidingTabIndicator` all assume an x-axis
  list. There is no vertical variant.
- `features/providers/provider-branding.tsx:23-31` — `PROVIDER_NOTES` already
  reads `anthropic: 'Claude Pro/Max subscription or your own API key'` and
  `openai: 'ChatGPT Pro/Plus subscription or your own API key'`. The simple
  model is already in the data; only the UI is complex.

## Locked scope decisions

These were decided by the user and are not open for re-litigation during
implementation.

1. `/accounts/**` is **deleted**. Every account-level setting moves into the
   panel.
2. **One** Members tab. Not two, not a segmented control.
3. `features/layout/user-menu.tsx` is **not dropped and not restructured**. The
   user has a separate plan for it. Only its settings call target changes.
4. The shell stays a **full-screen overlay** with a scope switcher. It does not
   become a route-first page.
5. The panel is renamed from **Customize** to **Settings**.
6. Tab triggers live **only** in the left sidebar. Content fills the pane.
7. Marketplace **stays** as a tab.
8. Skills, Agents, and Connectors stay as standalone capability pages.
9. Integrations is **not** built. Channels takes its slot.
10. Commands is **not** its own tab.

## Shell

The existing full-screen `Modal` is kept: `inset-0`, `h-dvh`, `w-screen`,
`animation="none"`, `closeOnOutsideClick={false}`, and the `.kx-titlebar-spacer`
guard that drops the modal below the macOS traffic lights and the Windows control
cluster. `Mod+,` continues to open it. The `hasOpenFloatingLayer()` /
`hasOpenNestedDialog()` escape-key guard is retained unchanged.

```
┌──────────────┬──────────────────────────────────────────┐
│ ✕  Close     │  Workspace › General                     │
│ ┌──────────┐ │  ┌────────────────────────────────────┐  │
│ │ Acme   ▾ │ │  │ Name and icon             [ Save ] │  │
│ └──────────┘ │  │ How this workspace appears to…     │  │
│              │  └────────────────────────────────────┘  │
│ YOU          │  ┌────────────────────────────────────┐  │
│  Profile     │  │ Delete workspace        [ Delete ] │  │
│  Preferences │  │ Permanently removes every session… │  │
│  Connected   │  └────────────────────────────────────┘  │
│              │                                           │
│ WORKSPACE    │                                           │
│  General     │                                           │
│  Members     │                                           │
│  …           │                                           │
│              │                                           │
│ ⬆ Upgrades   │                                           │
└──────────────┴──────────────────────────────────────────┘
   250px                 TabsContent, one scroll column
```

### Tabs wiring

A single `<Tabs orientation="vertical">` wraps **both** columns. `TabsList`
renders inside the sidebar `<section>`; `TabsContent` renders inside `<main>`.
Radix requires only a common `Tabs` ancestor, not sibling placement, so the
user's "triggers on the left, content on the page" constraint is met exactly.

This replaces the hand-rolled `RailButton` + `SectionContent` switch and yields,
structurally rather than by convention:

- Roving focus. Up/Down moves between tabs; Tab exits the list. Today all rail
  buttons are individual tab stops.
- `aria-controls` / `aria-labelledby` pairing between trigger and pane.

**Correction, 2026-08-09 — inactive panes are NOT unmounted.** An earlier draft
of this spec claimed they were. They are not, and the difference matters at 26
tabs. `TabsContent` wraps each pane in `Presence` and passes `children` as a
*function*; `Presence` derives `const forceMount = typeof children === 'function'`
and returns `forceMount || presence.isPresent ? clone : null`, so the `null`
branch is unreachable. **Every pane renders on every render, client and server.**
Inactive ones only carry `hidden`.

Consequence, and it binds every tab in this spec: **a pane must not fetch on
mount.** Gate each tab's queries on that tab being active — otherwise opening the
panel fires 26 tabs' worth of requests at once. This costs nothing to honour while
panes are being built and is expensive to retrofit afterwards.

`components/ui/tabs.tsx` gains a **vertical list variant**. This is a change to a
shared primitive used across the app, so it must be additive: existing horizontal
callers keep their exact rendered output. The vertical variant needs its own
indicator behaviour — `SlidingTabIndicator` measures on the x-axis and must
either gain a y-axis mode or be omitted for vertical lists in favour of the
existing active-background treatment.

### Scope switcher

The rail's existing `RelatedProjectsSwitcher` is re-purposed as the scope
switcher and sits directly under the close control. It selects **which workspace**
is being configured. It does not change the group set — the rail's five groups
are stable regardless of selection.

Tabs in the **You**, **Organization**, and **Developer** groups are not
project-scoped. They read the account of the selected workspace, or the user's
current account when the panel is opened with no workspace context. They are
reachable with no project selected.

### Section header primitive

One component, `SettingsSectionHeader`, used by every section in every tab. Its
markup is the block the user specified:

```tsx
<div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
  <div className="flex min-w-0 flex-col gap-1 text-base">
    <h2 className="font-regular text-foreground-strong text-base">{title}</h2>
    <p className="font-regular text-foreground-weak max-w-[410px] text-sm">{description}</p>
  </div>
  <div className="flex w-full min-w-0 items-center gap-4 sm:w-auto sm:justify-end">{action}</div>
</div>
```

Props: `title`, `description`, `action`. `action` accepts a button, a select, a
switch, or a dropdown. Destructive rows use the same component with a
destructive-variant button in `action`, per the Framer reference — there is no
separate danger-zone header.

`CustomizeSectionWrapper`'s internal `heading` block is replaced by this
component, removing the third competing header style.

## Information architecture

27 rail rows including the pinned footer. 24 with `agent_tunnel`, `review_center`,
and `voice` off.

| Group | Tab | Source |
| --- | --- | --- |
| **You** | Profile | `general-tab.tsx` + `security-tab.tsx` |
| | Preferences | `appearance-tab.tsx` + `sounds-tab.tsx` + `notifications-tab.tsx` + `keyboard-shortcuts-tab.tsx` + `language-switcher.tsx` |
| | Connected accounts | GitHub identity + `chatgpt-subscription-connect.tsx` + Claude Code |
| **Workspace** | General | `settings-view.tsx` identity + sandbox provider pin + danger zone |
| | Members | `members-view.tsx`, unified — see below |
| | Secrets | `secrets-view.tsx` |
| | Channels | `channels-view.tsx` |
| | Repositories | `git-view.tsx` + account GitHub app install |
| | Schedules | `ScheduleView type="cron"` |
| | Webhooks | `ScheduleView type="webhook"` |
| | Computers ᶠ | `computers-view.tsx` (`agent_tunnel`) |
| **Agent** | Models | rebuilt connect surface + the six `llm-*` sub-sections |
| | Instructions | agent instructions + `commands-view.tsx` folded in |
| | Marketplace ᶠ | `marketplace-view.tsx` (`marketplace`) |
| | Review ᶠ | `review-view.tsx` (`review_center`), keeps its needs-you badge |
| | Voice ᶠ | `voice-view.tsx` (`voice`) |
| | Sandbox | `sandbox-view.tsx`, templates half |
| | Snapshots | `sandbox-view.tsx`, build-log half |
| **Organization** | Billing | `billing-tab.tsx` |
| | Usage | `transactions-tab.tsx` with `billing/cost-explorer/` folded in above |
| | Groups | `components/iam/groups-tab.tsx` |
| | Roles | `components/iam/roles-tab.tsx` |
| | Identity | SSO + SCIM cards |
| | Audit log | `components/iam/audit-tab.tsx` |
| **Developer** | API keys | `cli-tokens-tab.tsx` + account tokens |
| | Experimental | `ExperimentalCard`, promoted out of `settings-view.tsx` |
| *pinned footer* | Upgrades | `migrate-to-v2/upgrade-view.tsx`, keeps its attention dot |

ᶠ = gated on a per-project experimental flag.

Group labels render as uppercase `Label` rows, matching the Ghost reference and
the rail's existing treatment.

## Tab contracts

### You › Profile

Sections, in order:

1. **Profile picture** — avatar, upload and remove actions.
2. **Name** — display name, inline save.
3. **Email** — current address, read-only, with the existing change flow if one
   exists.
4. **Two-factor authentication** — enroll and manage MFA factors (TOTP,
   phone), from `security-tab.tsx`. That file holds MFA only; there is no
   password-change surface in it, and none is invented here.
5. **Delete account** — destructive, confirmation required.

Log out is **not** placed here. It stays in `user-menu.tsx`, which is untouched.

### You › Preferences

Appearance leads, because the user specified a full light/dark system as the
centrepiece.

1. **Theme** — Light / Dark / System. Same three values, labels, icons, and
   order as `THEME_OPTIONS` in `user-menu.tsx`, which must not drift.
2. **Wallpaper** — the existing wallpaper set.
3. **Sounds** — sound packs and preview.
4. **Notifications** — browser notifications and delivery.
5. **Keyboard shortcuts** — reference list.
6. **Language** — `language-switcher.tsx`.

### You › Connected accounts

Three rows. One row per provider. Each row is a `SettingsSectionHeader` whose
`action` is exactly **one** button.

| Provider | Connected state | Disconnected state |
| --- | --- | --- |
| GitHub | installation name, `Disconnect` | `Connect` |
| ChatGPT | plan name, `Disconnect` | `Connect` |
| Claude Code | plan name, `Disconnect` | `Connect` |

No modal, no accordion, no search on this tab. The connect action may open the
provider's OAuth flow; it must not open a chooser.

**Scope conflict — flagged, needs the user's call.** None of these three is
user-scoped, so a tab named "Connected accounts" sitting in a group named "You"
holds nothing belonging to the signed-in person:

- **GitHub is account-scoped.** `GitHubConnectionCard` and `GitHubAppSetupCard`
  key on `account.account_id` and call `listGitHubInstallations(accountId)` /
  `deleteGitHubInstallation(accountId, installationId)`. Writing requires
  `account.write`.
- **ChatGPT is project-scoped.** `ChatGptSubscriptionConnect` takes `projectId`
  and calls `startProjectProviderOAuth(projectId, 'openai')`, then invalidates
  `qk.project.secrets(projectId)`.
- **Claude Code** follows the same project-scoped provider-OAuth pattern.

Two ways to resolve this, and the choice is the user's:

- **(a) As specified.** The tab stays under You. Each row states its scope in its
  description — "for the Acme account", "for this workspace" — and the GitHub row
  hides without `account.write`. The group label is then inaccurate.
- **(b) Move the tab to the Workspace group.** The scope switcher already names
  which workspace is being configured, so every row is then truthful. The You
  group drops to two tabs.

Recommendation: **(b)**. A row that silently writes to the account or the
workspace from a tab labelled as personal is the kind of thing that gets
discovered by an admin disconnecting a shared GitHub installation while believing
they are unlinking their own login. Implemented as (a) unless the user says
otherwise, because they specified it.

### Workspace › General

Workspace identity only, plus the danger zone. Name, icon, description, sandbox
provider pin, and Delete workspace. Members are **not** here; they are their own
tab.

### Workspace › Members

One table. One row per person. Two role columns.

| Person | Account role | Workspace access |
| --- | --- | --- |
| ana@ | Owner | Manager · *account admin* |
| bo@ | Member | Editor · *via Engineering* |
| cy@ | Member | — *(no access)* |

`Account role` renders `account_role`. `Workspace access` renders
`effective_project_role`, annotated from `effective_source`: `implicit` →
"account admin", `group` → "via {group_sources[0].group_name}", `direct` → no
annotation, `null` → an em dash and "no access".

Two write paths behind one row menu, each gated on its own leaf:

- Account writes — invite, change account role, remove. Leaf `member.invite`,
  `member.update`, `member.remove`.
- Workspace writes — grant, revoke, change project role, set the time-bound
  `expires_at`. Leaf `project.member.write`.

Pending invites and access requests keep their existing sections below the
table.

### Agent › Models

The rebuilt surface. Current state: 3,206 lines across 11 files, with
`connect-provider-content.tsx` at 1,076. The default path — paste an Anthropic
key — currently requires opening a modal, expanding an accordion, and passing a
search field.

Target: connecting a first-class provider is **one screen, one field, one
button**, with no modal.

1. **Connected** — what is connected now, each with a `Disconnect` action.
2. **Add a provider** — a short static list of first-class providers, each an
   inline row with a key field and a `Connect` button:
   - Anthropic (Claude) — API key, or connect a Claude Pro/Max subscription
   - OpenAI (ChatGPT) — API key, or connect a ChatGPT Plus/Pro subscription
   - Google Gemini — API key

   The subscription-versus-key wording already exists in `PROVIDER_NOTES`
   (`provider-branding.tsx:23-31`) and must be reused rather than rewritten.
3. **More providers** — a disclosure holding the long tail. Search lives here,
   not above.
4. **Custom provider** — OpenAI-compatible endpoint form, unchanged behaviour.

The rebuilt connect component is **one** component with two mounts: this tab and
the model selector's connect dialog. A third copy is not acceptable.

The six `llm-*` gateway sub-sections — `llm-overview`, `llm-providers`,
`llm-logs`, `llm-budgets`, `llm-keys`, `llm-api` — keep their current content and
remain gated on `llmGatewayAvailable`. They are reached from within the Models
tab. Their deep links continue to resolve; `isRailItemActive` currently maps
every `llm-*` section onto one rail entry and that mapping is preserved.

### Agent › Instructions

Agent instructions, with slash commands (`commands-view.tsx`) as a section below
them. Commands loses its rail row but not its surface: it is reachable only
through this overlay since its standalone page was deleted (#6169), so deleting
the row without folding the view would orphan the component and break three live
references — the `proj-commands` palette entry
(`menu-registry.ts:438` → `/projects/{projectId}/customize/commands`), the
section enum (`customize-sections.ts:22,53`), and the panel switch
(`customize-panel.tsx:393`). `/customize/commands` redirects to the Instructions
tab.

### Agent › Sandbox and Agent › Snapshots

`sandbox-view.tsx` currently renders two unrelated things: sandbox template CRUD
and the snapshot build log (`listProjectSnapshots`, `ProjectSnapshotBuild`,
`SnapshotErrorCategory`, per-build error classification). They split:

- **Sandbox** — template list, create, edit, delete, provider coverage.
- **Snapshots** — build log, build status, error categories, the accelerator-build
  filter (`isProjectAcceleratorBuild`).

### Developer › API keys

Table view, not cards. Columns: name, prefix, scope, created, last used, actions.
Search and filter above the table.

The tab carries a code snippet block showing how to use a key — the
`SettingsSectionHeader` for the section, then the snippet. The snippet is
copy-to-clipboard.

Both user CLI tokens (`cli-tokens-tab.tsx`) and account tokens appear here,
distinguished by a scope column rather than by two tabs.

**Assumption to confirm:** the table paginates and offers a text filter. The
user's instruction on this point was not fully legible.

## Route and deep-link contract

| Old | New | Behaviour |
| --- | --- | --- |
| `/projects/[id]/customize` | `/projects/[id]/settings` | permanent redirect |
| `/projects/[id]/customize/[section]` | `/projects/[id]/settings/[tab]` | permanent redirect, section name mapped |
| — | `/settings/[tab]` | new. Opens the panel with no workspace context, for You / Organization / Developer tabs |
| `/accounts/[id]?tab=billing` | `/settings/billing` | redirect |
| `/accounts/[id]?tab=transactions` | `/settings/usage` | redirect |
| `/accounts/[id]?tab=members` | `/projects/[id]/settings/members` | redirect |
| `/accounts/[id]?tab=groups\|roles\|identity\|audit\|tokens\|git\|settings` | matching `/settings/*` tab | redirect |

Section-name mapping for the customize redirect: `commands` → `instructions`,
`connectors` → the existing standalone capability page (unchanged), `settings` →
`general`, `sandbox` → `sandbox`, everything else 1:1.

`legacyCustomizeRedirect` and `resolveCustomizeOverlayHref` in
`lib/customize-sections.ts` are the single place this mapping lives. The
`CustomizeSection` union is renamed to `SettingsTab` and its members renamed to
match the new tab ids.

## Deleting `/accounts/**`

Files removed:

```
app/(app)/accounts/[id]/page.tsx                       2378 lines
app/(app)/accounts/[id]/groups/[groupId]/page.tsx
app/(app)/accounts/[id]/members/[userId]/page.tsx
app/(app)/accounts/[id]/tokens/[tokenId]/page.tsx
app/(app)/accounts/layout.tsx
app/(app)/accounts/loading.tsx
app/(app)/accounts/page.tsx
```

Two constraints on this deletion.

**`stores/account-settings-modal-store.ts` must be repointed.**
`openAccountSettings({ tab })` currently sets `window.location.href` to
`/accounts/${id}?tab=…`, a full document navigation. Four call sites depend on
it: the user menu, the global error handler, the upgrade dialog, and the error
banner. It becomes a store action that opens the panel on the requested tab.
`user-menu.tsx` keeps working with only its call target changed; its structure is
not touched.

**`/sso-setup` and `/scim-setup` are not deleted until verified.** These are
multi-step identity-provider wizards. Their URLs may be registered as redirect or
ACS targets inside a customer's IdP configuration, in which case deleting the
route breaks live enterprise SSO. Before removal, confirm whether either URL is
referenced by an external system. If it is, the route stays and the Identity tab
links out to it. This must not be resolved by assumption.

`/accounts` also hosts account **switching and creation**
(`create-account-modal.tsx`). That is not a settings surface and needs a
destination before the route is deleted. Resolving this is part of the phase that
removes the route.

## Permission gating

The existing model is preserved exactly. One batched `useProjectCans` probe over
the gate actions; a tab is visible when its read leaf resolved to
`allowed: true`; both loading and errored probes render the full rail. Visibility
only — the API re-checks every mutation.

Three additions:

1. Account-scoped tabs gate on account leaves (`billing.write`, `audit.read`,
   `role.create`, `member.invite`) via `usePermissions`, matching the current
   `sectionVisible` map on the account page.
2. Groups, Roles, Identity, and Audit are additionally **entitlement**-gated on
   `rbac`, `sso`/`scim`, and `auditAccess`. Per the current page, the tab stays
   **visible** for discoverability and the pane renders `EnterpriseUpsell`,
   mirroring the server's `402`.
3. `railGroups` keeps accumulating every optional item in one pass. An early
   return reintroduces the bug documented at `rail.ts:110`.

Empty groups drop out so no orphan header renders. If a deep-linked tab resolves
to denied after the probe settles, fall back to the first permitted tab — never
during the loading window, or a valid deep link is clobbered.

## Out of scope

- Skills, Agents, Connectors, and Files stay standalone capability pages.
- `user-menu.tsx` is not restructured. Only `account-settings-modal-store`'s
  target changes.
- No API changes. Every tab is served by an endpoint that exists today.
- Mobile gets the existing horizontal scrolling tab strip, restyled to the new
  primitive. No new mobile navigation model.

## Risks

1. **`tabs.tsx` is shared.** A vertical variant touches a primitive used across
   the app. Existing horizontal callers must render byte-identically.
2. **The account page is 2378 lines** and holds logic beyond its rail —
   member management, invite flows, IAM editors. Moving it tab by tab risks
   dropping behaviour. Each moved tab needs its behaviour enumerated before the
   source is deleted.
3. **`/sso-setup` and `/scim-setup` may be external redirect targets.** Deleting
   them on the assumption they are internal would break enterprise SSO in
   production. Verification precedes deletion.
4. **26 content tabs in one overlay** is a large rail. If it reads as too dense
   in the browser, the fallback is collapsing Groups and Roles into Members and
   Schedules and Webhooks into one Automations tab. Not decided; revisit after
   the shell is real and can be looked at.
5. **Marketplace is effectively always on** (`rail.ts:110`), so it is not a rare
   row. It occupies a permanent slot in the Agent group.
6. **Connected accounts holds nothing user-scoped.** GitHub is account-scoped,
   ChatGPT and Claude Code are project-scoped. A destructive action on that tab
   affects the account or the workspace, not the signed-in person. See the
   flagged decision under You › Connected accounts. Unresolved.
7. **`security-tab.tsx` is MFA-only.** If Profile is expected to offer a
   password change, that surface does not exist today and is new work, not a
   move.

## Verification

Per `CLAUDE.md`, a local pass and a dev pass are both required, and neither
replaces the other.

- `apps/web` `tsc --noEmit`, clean apart from the ~15 known `@types/bun`
  `test.each` errors in three test files.
- `npx eslint` on changed files, no errors.
- Unit tests for: the tab enum and its legacy redirect map, rail grouping under
  every flag combination, the account-to-settings redirect map, and the
  `effective_source` annotation logic in Members.
- Real-browser assertions on the deployed dev UI, per surface: click the tab,
  observe the network request, assert the visible result and the outgoing
  payload. Screenshots are supporting evidence, not the assertion.
- Explicitly verify the negative paths: a role missing a read leaf does not see
  that tab; a non-entitled account sees the upsell rather than the IAM pane; and
  every legacy URL in the redirect table lands on the right tab.
