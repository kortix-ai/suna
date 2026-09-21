# Kortix Mobile — design approach

Read this before building or restyling any screen in `apps/mobile`. It records
the patterns Jay has signed off on, with the exact values. `CLAUDE.md` in this
folder holds the primitive rules (which component to use); this file holds the
layout and visual decisions (how a screen looks).

When a rule here conflicts with an older screen, the rule wins. Convert the
screen when you touch it.

## 1. Settings screens

Every settings-style screen uses one layout, built from
`@/components/kortix/settings-list`: the Account page, the `(settings)`
sub-pages (Sounds, Notifications, Language, Delete account), Accounts,
Billing, and Plans. Do not hand-roll headers, rows, dividers, or group titles.

There is **one settings page**: the Account page
(`components/settings/AccountPage.tsx`). The Account tab renders it, and the
project sidebar's avatar opens the same page inside the project stack at
`/projects/[id]/account`. There is no `(settings)` index screen and no General
page.

| Export | Use |
| --- | --- |
| `SettingsHeader` | Back button + title + optional trailing action. `(settings)` screens get it from `_layout.tsx`; root-stack screens (`/accounts`, `/billing`) render it themselves with `Stack.Screen options={{ headerShown: false }}`; tab roots pass `showBack={false}`; project pages (Sessions, Account) pass `onOpenMenu`, which replaces Go back with the hamburger (`MenuButton`); `largeTitle` moves the title below the control row as an `h3` (Sessions) |
| `SettingsPage` | Scroll body. Tab roots pass `paddingBottom={useTabBarClearance()}` and `contentInsetAdjustmentBehavior={TAB_SCROLL_INSET_ADJUSTMENT}` |
| `SettingsGroup` | Titled, borderless rounded card with full-width separators |
| `SettingsRow` | icon (or `leading`) · label · trailing |
| `AppearanceRow` | The Appearance row: current mode as its value; opens a dialog with System, Light, Dark (icon · label · check) |

```tsx
import { SettingsGroup, SettingsPage, SettingsRow } from '@/components/kortix/settings-list';

<SettingsPage>
  <SettingsGroup title="Preferences">
    <AppearanceRow />
    <SettingsRow icon={Volume2} label="Sounds" onPress={() => go('/(settings)/sounds')} />
  </SettingsGroup>
  <SettingsGroup title="Help">
    <SettingsRow icon={BookOpen} label="Docs" external onPress={openDocs} />
  </SettingsGroup>
</SettingsPage>
```

### Page

| Property | Value |
| --- | --- |
| Body | `SettingsPage` — `ScrollView`, `bg-background`, no scroll indicator |
| Side margin | `px-5` (20pt) |
| Space between groups | 18pt |
| Bottom padding | safe-area inset + 28pt |
| Content above groups | `header` prop (e.g. the profile photo on the Account page) |
| Pinned bottom action | render the pill below `SettingsPage` in a `bg-background px-5 pt-3` view with `max(insets.bottom, 16)` bottom padding, and pass `paddingBottom={24}` to the page (Plans) |
| Full-bleed hero | `hero` prop (Billing). The hero scrolls with the page; the body sits on a `rounded-t-3xl bg-background` sheet that overlaps the hero’s bottom 24pt, so the hero keeps ≥ 24pt bottom padding |

### Header

| Property | Value |
| --- | --- |
| Component | `SettingsHeader` from `settings-list` — one header for every settings-style screen |
| Go back | `PlatformButton` — native SwiftUI button on iOS (`chevron.left`, plain style on the `secondary` fill), `Button variant="secondary"` icon pill on Android |
| Back behaviour | `router.back()`; if there is no history, `router.replace('/projects')` |
| Title | screen name, sentence case |
| Trailing action | `right` prop — e.g. `PlatformButton label="New" systemImage="plus"` on Accounts |
| Hero header | `align="center"` + `transparent` over a `SettingsPage` hero. Pair a centred title with icon-only actions; an empty side gets a 40pt spacer |

Register a new `(settings)` screen in `_layout.tsx` with
`header: () => <SettingsHeader title="…" />`.

### Group

| Property | Value |
| --- | --- |
| Title | `Text variant="muted"`, `mb-2 px-4`, **sentence case** ("Sound pack", not "SOUND PACK"). Never uppercase, never letter-spaced eyebrows |
| Surface | `Card` with `rounded-2xl border-0 gap-0 py-0 overflow-hidden` — card background colour, **no border**, 16pt corners |
| Dividers | full-width `Separator` between rows (under the icon area too), inserted by `SettingsGroup`. Rows never draw their own |
| Empty group | renders nothing — conditional rows (`{cond && <SettingsRow/>}`) are safe |

### Row

A row is **icon · label · trailing**. Nothing else.

| Property | Value |
| --- | --- |
| Padding | `px-4 py-3` (py one step below px — see §2 Spacing) |
| Icon | Phosphor from `@/lib/icons` at the app weight (no `weight` prop), `size={18}`, `text-foreground/80`, centred in a leading slot at least 20pt wide (`min-w-5`) so every label aligns. A row with no `icon` and no `leading` drops the slot and its `mr-3` gap, so its label starts at the card padding. A loading row keeps the slot with a `<Skeleton>` so its label does not shift |
| Custom leading | `leading` prop instead of `icon` — flag emoji (`Text variant="large"`) on Language, `Avatar variant="custom" size={28}` on Accounts |
| Label | `Text` default variant, one line, sentence case ("Edit profile", "Delete account") |
| Long label | `multiline` prop wraps the label instead of truncating it. Only for list content that is the label itself: plan features on Plans and the upgrade sheet (`Check` icon · feature). Never a way to add a description |
| Description | **none**. Do not add a second line under the label |
| Chevron (navigates in-app) | `CaretRightIcon`, `size={16}`, `text-muted-foreground/70` — shown automatically when the row has `onPress` |
| External link (opens browser) | `external` prop → `ArrowUpRightIcon`, same size |
| Read-only value | `value` prop → muted text on the right, max 60% width, one line (e.g. the account email) |
| Inline control | `right` prop → `Switch`, `ToggleGroup`, check mark, icon button. Replaces the chevron |
| Selected option (picker) | `checked` prop → primary check mark. Picker rows also pass `right={null}` so no chevron shows (Sound pack, Language) |
| Active item that still navigates | `checked` + default chevron (the active account on Accounts) |
| Appearance | always `<AppearanceRow />` — a `Dialog` (not a page, not an inline toggle) listing System, Light, Dark in that order, each with its icon (`Monitor`, `Sun`, `Moon`) and a check on the active mode, in a `SettingsGroup className="bg-secondary"` on the `bg-popover` dialog; choosing applies and closes. Dialog width is explicit — `min(window width − 32, 420)` — because `w-full` collapses to content inside the native overlay wrappers |
| Destructive | `destructive` prop → icon and label `text-destructive` (Delete account, Sign out) |
| Badge | `badge` prop → small destructive pill after the label (e.g. "Scheduled") |
| Plan badge | `PricingTierBadge` in `right` (Account page email row, Billing Current plan). Legacy tiers (Basic, Plus, Pro, Ultra) render their SVG artwork. Any other plan name renders a pill in the artwork's shape: full radius, `THEME.light.border` fill and `THEME.light.foreground` text in both themes, label at 55% of the pill height. Never leave the slot empty |
| Press feedback | background highlight `active:bg-accent`. Never scale a row inside a card |

### Account tab and account screens

| Screen | Structure |
| --- | --- |
| Account page (`AccountPage`) | `presentation="tab"` (Account tab): page title "Account" (`Text variant="h3"` in a 40pt row, part of the scroll content — no header bar, no logo, page background). `presentation="project"` (`/projects/[id]/account`, from the project sidebar avatar): `SettingsHeader title="Account"` with the hamburger (`onOpenMenu` → the project drawer), no Go back, no h3. Both then: profile header (80pt `ProfilePicture`, tap → system photo picker; 28pt camera badge `bg-secondary` with a 2pt `border-background` ring at the bottom-right; `KortixLoader size="small"` over the photo while uploading; display name `Text variant="large"` centred below) → one untitled group (no icon · email · `PricingTierBadge size="md"` for the active account's plan, always shown: `plan.label` from the API, else `tier_display_name`; no icon · Edit profile → `EditProfileSheet`) → Preferences (Appearance, Sounds, Notifications, Language) → Workspace (Accounts, Billing) → Help → **Advanced** (Delete account, Sign out — destructive, last) |
| Edit profile | `EditProfileSheet`: `Sheet` + `SheetHeader` "Edit profile" + `SheetTextInput` (display name, max 100) + `Button size="lg" rounded-full` Save, disabled until the name changes. Save closes the sheet; a failure is a toast |
| Delete account (`/(settings)/account-deletion`) | Groups: What gets deleted (icon · label, read-only) → When (picker: In 30 days ✓, Immediately) → destructive `Button size="lg" rounded-full`. The pill opens ONE `AlertDialog` with two steps, for both timings (`lib/account-deletion/confirm-flow.ts`): (1) title + consequence line, auto-focused `<Input>` "Type DELETE to confirm", destructive Continue disabled until the word matches (trimmed, any case); (2) "Are you sure?" + "Everything in your account is deleted…", destructive Delete that stays disabled for 1s after the step appears, so a double tap on Continue cannot delete. The steps swap inside the same dialog — never two overlays. Scheduled deletion: one row (Calendar · Scheduled for · date) + secondary pill Cancel deletion (no confirmation — it is safe) |
| Plans (`/plans`) | `SettingsHeader "Plans"` → Plan picker group (plan icon · name · price or "Current" · check) → seat total row for Team with more than one member → "{plan} includes" group (`Check` · feature, `multiline`) → pinned primary pill. The pill opens kortix.com (arrow icon): Upgrade to Team / Switch to Free → web billing, Contact sales → `/contact`; disabled "Current plan" or "Ask an account owner to upgrade". Logic: `lib/billing/plan-action.ts` |
| Upgrade sheet (`GlobalUpgradeSheet`) | Centred "Kortix Team" (`large`) · price (`h1`, tabular) · "per seat / month" (`muted`) · gate message (`muted`) → Includes group (`multiline`) → seat total row → primary pill "Upgrade to Team" (→ Plans) or an Ask an account owner row → secondary pill Not now |
| Projects header | Kortix logo · search · New. No settings/avatar button — the Account tab owns settings. Search shows only when the account has at least one project (hidden while loading and when empty) |
| Projects empty state | Plain page, centred between header and tab bar: "No projects yet" (`Text variant="large"`) · 24pt gap · primary `Button size="lg" rounded-full` "Create project" (owners and admins only). No card, border, fill, icon, or description |
| Account detail (`/accounts/[id]`) | `SettingsHeader title={account name}` + tab switcher (Members, Groups, Git, Audit, Settings). No avatar/name/"1 member · 1 project" block |
| Tab content | `SettingsPage`; primary action (Invite member, Create group, …) as the first row group; lists as titled groups of avatar/icon · name · value · chevron; row actions on the detail screen or an action sheet, never inline icon buttons |
| Detail screens (member, group) | `SettingsHeader title={name}`; destructive action alone at the bottom |
| Billing (`/billing`) | `SettingsPage hero={<BillingHero …/>}`: warm gradient (`THEME.accent.red` → `.orange` at low alpha over the theme background, diagonal sheen), centred transparent header with a help icon (Credits explained), balance label (`Text variant="large"`) + balance (`h1`, tabular), breakdown rows (label · semibold tabular value, no icons), one primary pill (`Button size="lg" rounded-full`, label left; chevron right, or an arrow when it opens the browser): Buy credits (→ web billing) when the plan can buy credits, else Change plan (→ Plans). Loading: `KortixLoader` in an `h-64` box, no skeleton bars. Sheet: Scheduled change (New plan, Starts on, Keep current plan → `AlertDialog`) → Subscription (Current plan badge or name, Next billing, Annual commitment, Cancels on, Change plan when the hero shows Buy credits, Manage on kortix.com — external). Reads the active account (`useActiveAccount`), the same one as the Account page badge; refetches on pull to refresh and when the app returns to the foreground |

No subtitles, helper paragraphs, or meta lines anywhere on these screens.

| Pattern | Value |
| --- | --- |
| Accounts list | one untitled `SettingsGroup` — the header already says "Accounts" |
| Row ⋯ menu (Projects) | `ProjectActions`: bottom `Sheet` with the item's avatar + name and one untitled `SettingsGroup` of actions (Open project; Archive project, destructive, managers only). A destructive action confirms in an `AlertDialog` that opens after the sheet has closed — never two overlays at once |
| Android / web tab bar | `FloatingTabBar`, mirrors the iOS bar: 60pt capsule (`FLOATING_BAR_HEIGHT`), icon (20pt) over a 12px label, `bg-secondary` pill thumb behind the active tab, foreground icon + label on every tab. Light: `bg-background` + soft shadow; dark: `bg-card` + border. Behind it, a scroll-edge fade (theme background, transparent 36pt above the capsule → opaque at the screen edge), like the iOS 26 bar. Hides on React Native `Keyboard` events, not keyboard-controller values. Android nav bar: `expo-navigation-bar` `enforceContrast: false` (no 3-button scrim in builds) + `NavigationBar.setStyle` matching the status bar |
| Project stack | `/projects/[id]` is a nested stack: `app/projects/[id]/_layout.tsx` renders `ProjectScreen`, `index` is project home, `view` is the open page, thread, or connecting session, `sessions` is the Sessions page, `files` is the Files page, and `account` is the Account page (`components/session/ProjectRoutes`, route names in `lib/session/project-stack.ts`). The stack is `[index]` or `[index, X]` — never deeper than one screen over project home. **Every project page shows the hamburger and no Go back** (Jay, 2026-09-16): project home, a thread, and a connecting session show `FloatingMenuButton`; every project page uses one 16pt side edge (`px-4`; Jay, 2026-09-16): `PageHeader` `px-4`, `FloatingMenuButton` `left-4`, the home composer `px-4`, `SearchListHeader` `px-4` by default, and `SettingsHeader`/`SettingsPage` `gutter="project"` on Sessions and Account (the Account tab and settings screens keep 20pt `gutter="page"`); tool-page bodies still set their own inline padding (mostly 16pt) — not yet converted; every hamburger is `MenuButton` (`components/kortix/menu-button.tsx`), the same on every platform — no native Liquid Glass circle on iOS (Jay, 2026-09-17): `Button variant="ghost" size="icon" className="-ml-2.5 rounded-full bg-background"` (page colour, so a floating hamburger hides the content scrolling under it) (the −10pt margin puts the icon glyph on the page's padding edge, parallel to the title and list), static `MenuIcon` 20pt `text-foreground` (`components/icons/menu-icon.tsx`: three left-aligned bars, 24/11/13 wide; Jay, 2026-09-17), 10pt hit slop, label "Open menu" — transparent at rest, `active:bg-accent` while pressed, no open/close animation (Jay, 2026-09-16); tool pages and Files show `PageHeader`'s hamburger; Sessions and Account show `SettingsHeader onOpenMenu`. The drawer opens from every project route (hamburger or left-edge swipe). Drawer moves (`drawerRouteMove`, `returnHomeMove`): Sessions / Files / avatar push over home, replace a covering route, and do nothing when that route is already on top; a session row only updates the tab store (home pushes `view`, an open `view` swaps its content, a covering route replaces itself with `view` — `useCoveringRoute`); New session resets the store and pops to home (`StackActions.popTo('index')`); All projects `router.replace('/projects')` (the logomark is not tappable). Never replace `view` with `view`: the old view's cleanup would close the session that just opened. Back: Android back closes an open drawer, else pops a covering route to project home (`androidBackMove`), else on home is left to the system. iOS has no swipe-back in the project stack (`gestureEnabled: false`, `fullScreenGestureEnabled: false`): the left edge opens the drawer on every project route — one edge gesture, one meaning. `projects/[id]` itself has `gestureEnabled: false` and always opens with `router.replace`, so no screen sits under a project. The Projects list opens only from the project sidebar. A project always opens on project home: the tab store neither restores nor persists the active page or thread |
| App start | `app/index.tsx` is the door (web `/projects/start`): signed out → `/auth`; signed in → the last project this user opened (`useLastProjectStore`, keyed by user id), else the first project (`lib/projects/landing.ts`: selected account, then owned/admin, then member accounts), via `router.replace`. The Projects list only when no account has a project. Failure: 2 retries, then a centred message (`large` title, `muted` line) chosen by `lib/projects/start-failure.ts`: unreachable → "Can't reach Kortix" / server error → "Could not open your project", each with `size="lg"` pills Try again (primary) · All projects (secondary, opens `/projects`) · Sign out (ghost); a 401/403 → "Your session has ended" with one primary pill Sign in again. Never a dead end, never an automatic fall back to the list. Every implicit redirect (sign-in, back with no history, leaving an account) goes to `/`, never `/projects` |
| Push transition | Every stack (root, `(settings)`, `auth`, project) is expo-router's native `Stack` with the platform default push/pop on iOS and Android — no custom animation. The root `index` redirect has `animation: 'none'`. Swipe-back is iOS-only, and off in the project stack (its left edge opens the drawer); Android uses the system back gesture. |
| Tab root headers | The Account tab has no screen header — the profile block is the top of the page (status-bar inset: automatic on iOS, `insets.top + 16` on Android) |
| Confirmations | `AlertDialog` (`rounded-3xl` content — `Dialog` and `AlertDialog` are borderless in the primitives, on `bg-popover` — the same surface as bottom sheets — over a `bg-black/70` overlay; call sites never set a background; footer: destructive `Button size="lg" rounded-full` + `AlertDialogCancel asChild` secondary pill). Never `Alert.alert`. Sign out, Delete account, and Keep current plan keep the dialog open while they run and show a failure in the description. Delete account always asks for a typed confirm word and then a second question with a delayed Delete button (both timings); taps alone never delete. Keep current plan confirms with the buttons alone, and a safe action (Cancel deletion) does not confirm |
| Results | Success of an action that leaves the page in place → `useToast().success`; a failure outside a dialog → `useToast().error`. Never `Alert.alert` |

### Copy

- Labels name the destination or setting in 1–2 words, sentence case.
- Group titles group by user intent: Preferences, Profile, Account, Help,
  Advanced, Sound pack, Sound events, Feedback.
- Destructive actions live in their own group at the bottom (Advanced / Account).

## 2. Spacing

Padding is written as plain Tailwind classes in each component — no shared spacing module. Mobile uses stock Tailwind spacing (1 unit = 4pt: `px-4` = 16pt). The values below are the only ones to use.

Jay's rule (2026-09-16): **vertical padding is one Tailwind step below horizontal padding** on every padded row, list item, and inset block. Pick the side padding for the surface, then take one step off for the top and bottom.

| Pair | Pt | Use |
| --- | --- | --- |
| `px-3 py-2` | 12 / 8 | Edge rows: project sidebar session rows and Previous chats, inside an `mx-4` column so the highlight box starts on the 16pt edge and the content on the 28pt edge |
| `px-4 py-3` | 16 / 12 | Rows inside a card or group (`SettingsRow`, Sessions page rows) — the default |
| `px-5 py-4` | 20 / 16 | Roomy blocks and page sections |

- Never set py below px − 1 step (`px-4 py-1.5` reads cramped) or equal to px (`px-4 py-4` reads loose).
- Side edges: project pages use a 16pt edge (`px-4`, Jay 2026-09-16 — 12pt was too tight); the Account tab and settings screens use 20pt (`px-5`).
- A control's icon sits on the padding edge, not the control's box: `MenuButton` pulls itself left by `-ml-2.5` so the hamburger glyph lines up with the title and list below it.
- Fixed-height controls (`Button` sizes, 40/44pt inputs) keep their size variants; this rule is for padded content, not for `Button` boxes.

## 3. Buttons

| Situation | Use |
| --- | --- |
| Primary header action (e.g. projects "New") and screen back buttons | `PlatformButton` — native iOS SwiftUI button (plain style, `secondary` fill, no glass), design-system pill on Android |
| The project hamburger | `MenuButton` — the design-system ghost icon button on every platform. No native Liquid Glass circle on iOS (Jay, 2026-09-17) |
| Everything else | `Button` from `@/components/ui/button` with `variant` + `size` |
| Pill shape | `className="rounded-full"` — the only visual class allowed on a `Button` |
| Never | `h-*`, `w-*`, padding, or text size/weight classes on a `Button` or its `Text` |

`PlatformButton` needs the `ExpoUI` native module (`@expo/ui`). A binary built
without it falls back to the design-system button, so OTA updates stay safe.
Adding or upgrading native modules requires a new binary (`npx expo run:ios`
locally, EAS for stores).

### Inputs

| Rule | Value |
| --- | --- |
| Border | **none**, on every input. Fields are filled surfaces |
| Surface | `bg-secondary` (the `secondary` token) |
| Text | 16pt Roobert Regular — `INPUT_FONT_SIZE` / `INPUT_FONT_FAMILY` from `pill-input.tsx`, `font-roobert text-base` on `<Input>` |
| Placeholder | same size and weight as the text, `muted-foreground` colour (never a lighter opacity) |
| Which field | `<Input>` (rounded-xl, 44pt) for forms; `PillInput` (pill, 44pt) on full screens like auth; `SheetTextInput` inside bottom sheets; `SearchBar` / `SearchListHeader` for in-page search; `SearchHeader` for header search mode |
| Never | local `border-*`, `text-[NNpx]`, `font-*`, or height classes on an input |

## 4. Auth screens

| Element | Value |
| --- | --- |
| Welcome | full-bleed `KortixCurrents` hero, logomark, provider pills as `PlatformFullWidthButton` (`size="xl"`, 48pt — the only `xl` Buttons in the app; Jay, 2026-09-17): native SwiftUI capsules on iOS (Jay, 2026-09-17), design-system `Button` `rounded-full` elsewhere, same variants on both (Google and Apple `default`, email `outline`), provider icon pinned to the pill's left edge. No legal links (Jay, 2026-09-17) |
| Email screen | back `PlatformButton`-style header, `PillInput` fields (44pt, matches `Button size="lg"`), primary pill, bottom pinned secondary pills. No legal links (Jay, 2026-09-17) |
| Fields | `PillInput` on full screens, `SheetTextInput` inside bottom sheets — never `<Input>` restyled by class |

## 5. Project home

`/projects/[id]` with no chat open (`components/session/ProjectHome.tsx`,
COR-34). It matches the web project home: simple and clean, nothing extra.

| Element | Value |
| --- | --- |
| Greeting | `ProjectGreeting`: `KortixLogo` (38pt) over one sentence, `gap-4`. Centred on the screen; centred in the area above the keyboard while typing |
| Message | Always "Give {project name} something real to work on." (web `HOME_GREETINGS[0]`, pinned by `lib/session/project-greeting.test.ts`). No rotation, no variants. `Text variant="lead"`, centred; the name is `text-foreground`, the rest muted. Unknown name → "it" |
| Chat input | `Composer`: one borderless `rounded-3xl` card (light `bg-background` + `LIGHT_SHADOW`, dark `bg-card`). Text field on top (16pt Roobert, plain "Ask anything" placeholder, no animation). Row below: add (`Button variant="secondary" size="icon"`, `+`) · model pill (`Button variant="secondary"`, model name) · spacer · send (`Button size="icon"`, secondary when empty, primary when there is something to send). All `rounded-full` |
| Chat input position | Pinned to the bottom with `px-4` (`insets.bottom + 8`, matching the thread composer's own bottom gap); follows the keyboard to 8pt above it. Text, files, and model stay until the send succeeds |
| Add (`+`) | `useAttachmentPicker`: photo library, camera (iOS), files. Files show as chips (thumbnail · name · remove). They upload after the new session connects |
| Model pill | Project gateway catalog (`useProjectModelCatalog`), label = the pick or the project default. Opens `ModelPickerSheet` (one `SettingsGroup` of checked rows). Sent as `opencode_model`. Hidden when the project has no LLM gateway |
| Chrome | Floating menu button (top left). It belongs to the project screen, not to the home. (The project dock that used to share this row was removed, 2026-09-17 — nothing replaced it: Files/Browser/Agents/Skills/Memory/Settings, the More sheet, chat actions, "Open change request", and "New chat" have no floating entry point from project home or a thread) |
| Never | Starter chips, recent-session lists, cards, widgets, subtitles |
| New chat, no messages | `SessionPage`'s `FreshSessionHero` renders the same `ProjectGreeting` |

## 6. Project sidebar

The left drawer on `/projects/[id]` (`components/session/ProjectLeftDrawer.tsx`).
It opens from every project page: the hamburger, or an edge swipe (80pt edge,
`swipeEnabled` while the project screen is focused) on any project route.
A swipe closes it (no close button). Every action calls `onClose()` before it
navigates. Navigation from the drawer never deepens the project stack beyond
one screen over home:

| Action | Project home on top | A covering route (`view`, `sessions`, `files`, `account`) on top |
| --- | --- | --- |
| Sessions / Files / avatar | push that route | replace the top route with it; nothing when it is already on top |
| Session row | tab store update → home pushes `view` | `view`: the row of the session on screen only closes the drawer; another row updates the store and the view swaps content. `sessions`/`files`/`account`: store update, the route replaces itself with `view` (`useCoveringRoute`) |
| New session | go to project home | go to project home + `popTo('index')` |
| All projects | `router.replace('/projects')` | same |

```
┌──────────────────────────────────────────┐  full screen width
│ [Kortix logomark]                         │
│   ▢ Sessions                              │  box edge 16pt, icon edge 28pt
│   ▢ Files                                 │
│   ▢ All projects                          │
│  ◌ Session title                          │  scrolls; 20 newest
│  ● Session title                          │
│  Previous chats                           │
│ ░░░░░░░░░░░░░░░░ fade ░░░░░░░░░░░░░░░░░░ │
│ [+ New session]                   (photo) │  pinned, 16pt above safe area
└──────────────────────────────────────────┘
```

| Element | Value |
| --- | --- |
| Drawer | `react-native-drawer-layout`, `drawerType="slide"`, width `100%`, transparent overlay, no shadow (`ProjectScreen`) |
| Surface | `bg-chrome-background` (the web `--sidebar` token), `insets.top` top padding. **One straight left line at 20pt** (Jay, 2026-09-16): the Kortix logo, the Sessions / Files / All projects icons, the session status marks, and Previous chats all start at 20pt — the header is `px-5`; every row is `px-3` inside a `px-2` column |
| Header row | `px-5 py-2` (logo on the 20pt line), the logomark alone: `KortixLogo variant="logomark" size={18}` (90 × 18pt: the logomark is 5:1) in a 44pt-tall `View`, **not tappable** (`accessibilityRole="image"`, label "Kortix"). Only the All projects row opens the Projects list; the logo never navigates (Jay, 2026-09-16). No close button (Jay, 2026-09-16): an edge swipe closes the drawer |
| Nav rows | `NavPill` rows in a `px-2 pb-2` column, no gap: `Pressable` `flex-row items-center gap-3 rounded-xl px-3 py-2.5 active:bg-accent` (44pt), icon `size={18}` `text-foreground` on the 20pt line, label `Text` `font-medium`, one line. Order: Sessions (`ChatsTeardropIcon`, → `sessions`), Files (`FoldersIcon`, → `files`), All projects (`CustomizeIcon`, web's Customize glyph from `components/icons/customize-icon.tsx`, → `router.replace('/projects')`, the only way to the Projects list). Sessions and Files go through ProjectScreen's `navigateProjectRoute` (push or replace, see the table above) |
| Double-tap guard | Sessions, Files, All projects, and the avatar navigate once: the first tap sets `navigatingRef`, later taps do nothing. The guard resets when the drawer's visibility flips — `useDrawerProgress()` crosses 0.01 (fully closed, or visible again), read with `useAnimatedReaction`. No timer. The drawer content stays mounted while closed, so mount cannot reset it |
| Row style | Menu rows, not free-standing buttons: no resting fill, no border; the pressed `bg-accent` box and the open session's resting `bg-accent` box sit on the parent's `px-4` edge with the same `rounded-xl` radius |
| Session list | `ScrollView` under the nav rows, no indicator, `paddingTop` 4. Rows in a `px-2` column (status marks on the 20pt line): `Pressable` `flex-row items-center gap-3 rounded-xl px-3 py-2 active:bg-accent`. Open session: the row of the session on screen (an open thread or a connecting session, `shownProjectSessionId`) is `bg-accent` at rest with `accessibilityState={{ selected: true }}`, same font weight; tapping it only closes the drawer (`drawerSessionRowMove`), so the thread is not remounted or reconnected. Row = `SessionStatusMark` (the same marks as the Sessions page, see §7) · title (`Text` default, one line, `sessionDisplayTitle`). Label "{title}, {status}" (`sessionStatusLabel`). Rows are `recentSessions(sessions, DRAWER_RECENT_SESSIONS)`: the 20 newest by `sessionLastActivityAt`, newest first. The Sessions row opens every session |
| Loading | `KortixLoader size="small"` centred, `py-8` |
| Empty | `Text variant="muted"` "No sessions yet", `px-3 py-2` (aligned with a row's title) |
| Previous chats | `LegacyChatsSection` after the rows, `mt-2`, inside the scroll content. In a `px-2` column; its header and chat rows are `px-3 py-2`, so they start on the 20pt line (§2). Renders only when the account has pre-OpenCode chats |
| Session list top fade | A 24pt `expo-linear-gradient` of the drawer surface (`THEME.*.chromeBackground`, alpha 1 → 0) over the top of the list, `pointerEvents="none"`, so rows fade out under the nav pills instead of a hard edge. Its opacity follows the scroll offset (Reanimated, UI thread): 0 at rest, 1 after 24pt of scroll, so the first row is never dimmed |
| Bottom bar | Absolute at the bottom, full width, `pointerEvents="box-none"`. Background: an `expo-linear-gradient` fade of the drawer surface (`THEME.*.chromeBackground`) — alpha 0 → 0.85 → 1 at locations 0 / 0.45 / 1, `pointerEvents="none"` — from 36pt above the controls to the screen edge (the same fade as the floating tab bar). No solid fill. Controls: a `flex-row justify-between px-5` row (the New session pill on the 20pt line) whose bottom is `insets.bottom + 16` (16pt above the home indicator). The list's bottom padding is that offset + 44 + 16, so its last row rests above the controls and earlier rows fade out under them |
| New session | `Button size="lg" className="rounded-full"` — the default (primary) variant, 44pt, `NavigationArrowIcon` flipped horizontally (`scaleX: -1`), tip up-right (web's New session glyph, `size={20}`) + "New session", content width. `haptics.tap()` → `onClose()` → `onNewSession()` (ProjectScreen `returnHome`: reset the store and pop a covering route, so project home's composer starts the session) |
| Avatar | `ProfilePicture size={11}` (44pt, the `lg` pill height) from `useProfileEditor()` — the Account page's photo and name; initial when there is no photo. `Pressable rounded-full active:opacity-70`, 2pt hit slop, label "Account". No name or email. → `/projects/[id]/account` through `navigateProjectRoute` (push over home, or replace a covering route) |
| Haptics | `haptics.tap()` on every button and pill. Session rows: one `haptics.tap()`, fired by ProjectScreen (`handleOpenProjectSession`, or the close-only path for the open session's row); the drawer adds none |

Intentionally absent — do not add back:

- Search row and the command palette (deleted).
- The user card footer (name, email, plan, update dot). The avatar is the only account entry.
- A New session row at the top. New session lives only in the bottom bar.
- A Review button. Mobile has no Review Center; `ChangesPage` is change requests only.
- The sandbox-scoped Projects tree, and any collapsible section header or chevron over Sessions.
- Row descriptions, timestamps, or counts.

## 7. Project sessions page

`/projects/[id]/sessions` (`components/session/ProjectSessionsPage.tsx`),
opened by the sidebar's Sessions row (pushed over project home, or replacing
the covering route). It lists every
session of the project. Title, status, grouping, search, and relative time
come from `lib/session/session-list.ts` (unit-tested).

| Element | Value |
| --- | --- |
| Header | `SettingsHeader title="Sessions" largeTitle gutter="project" onOpenMenu`: the hamburger (opens the project drawer) alone in the control row, no Go back; the title "Sessions" below it as `Text variant="h3"` (`accessibilityRole="header"`) in an `h-10 px-4 pb-1` row, above the search field |
| Search | `SearchListHeader` (16pt `px-4`, its project default), placeholder and label "Search sessions". Shown only after loading and only when the project has at least one session; when the list becomes empty the query is cleared. Trimmed, case-insensitive match on the display title (`filterSessionsByTitle`). Clear button label "Clear search" |
| Groups | Today · Yesterday · This week (2 to 7 local calendar days before today) · Older, by `sessionLastActivityAt`, newest first (`groupSessionsByActivity`). Empty groups are omitted. Headers show only when more than one group has sessions (`showHeaders`): `Text variant="muted"`, `mb-2 px-4`, role header, 18pt above every header but the first |
| List | `SectionList`, no sticky headers, no indicator, `paddingHorizontal: 16` (the project edge), top padding 4, bottom padding safe-area inset + 28, keyboard dismisses on drag |
| Row surface | A borderless card per group, one `bg-card` surface per row (the list stays virtualised): first row `rounded-t-2xl`, last row `rounded-b-2xl`, full-width `Separator` between rows |
| Row | `Pressable` `flex-row items-center px-4 py-3 active:bg-accent` (§2: py one step below px, same as `SettingsRow`): `SessionStatusMark` (20pt slot, `mr-3`) · title (`Text` default, one line, `flex-1`, `sessionDisplayTitle`) · time (`Text variant="muted"`, `ml-3 tabular-nums`, `shortRelative`: now, 5m, 2h, 3d, 2mo, 1y). The clock re-renders every 60s and on each refetch. No description |
| Tap | Opens the session once per page (`useCoveringRoute`'s `leavingRef`). The view route replaces this page (`StackActions.replace`), so the stack stays one screen over project home. The page fires no haptic; ProjectScreen's `handleOpenProjectSession` fires one `haptics.tap()`. If the store opens a session without a tap (notification, deep link), the page replaces itself with the view the same way |
| Long press | `haptics.medium()`, then a bottom `Sheet`: title (`Text variant="large"`, role header, one line) over one untitled `SettingsGroup`. Actions: Rename (`Pencil`) · Share (`Share`, only when `can_manage_sharing !== false`) · Restart (`RotateCcw`) · Stop (`Square`, only while running) · Delete (`Trash2`, destructive, `haptics.warning()`). Restart, Stop, and Delete need `can_manage_lifecycle !== false`. Chevron rule: Rename and Share open another sheet and keep the chevron; Restart, Stop, and Delete pass `right={null}` |
| Sheet follow-ups | Rename (`SessionRenameSheet`), Share (`SessionShareSheet`), and Delete open only after the action sheet has dismissed — never two overlays. Restart and Stop close the sheet and run at once: `toast.success` "Session restarting" / "Session stopped", or `toast.error` "Unable to restart the session. Try again." / "Unable to stop the session. Try again.". A repeat of the same action on the same session is ignored while one runs. Rename and Share failures are `toast.error` |
| Delete dialog | `AlertDialog`, title "Delete session", description `Delete “{title}”? Its sandbox is destroyed. This cannot be undone.` Footer: `AlertDialogCancel asChild` secondary `size="lg"` pill "Cancel" · destructive `size="lg"` pill "Delete session" ("Deleting…" while it runs). Both disabled while the delete runs, and the dialog stays open until it settles. Failure: `haptics.warning()`, the description becomes "Unable to delete. Check your connection and try again." in `text-destructive`, dialog stays open. Success: the session's tab closes, `haptics.success()`, `toast.success` "Session deleted", dialog closes. The title stays in the description while the dialog animates closed |
| Loading | `KortixLoader` centred in the page, no search field |
| Empty / no matches / error | Centred `Text variant="muted"` (`px-8`, `text-center`): "No sessions yet"; "No matching sessions" when the search hides every row; "Unable to load sessions. Pull to refresh." when the load failed and nothing is cached |
| Pull to refresh | `RefreshControl` (tint `mutedForeground`) refetches the project's sessions |
| Accessibility | Row label "{title}, {status}, {spoken time}", e.g. "Fix login, Running, 5 minutes ago" (`spokenRelative`: "5m" would read as "5 meters"). Hint "Opens the session". Actions: activate, and longpress labelled "Session actions" (opens the sheet). The mark is hidden from screen readers |

Status marks (`components/session/SessionStatusMark.tsx`), shared with the
project sidebar. Each state differs in shape, not colour alone:

| Display status | Source statuses | Mark |
| --- | --- | --- |
| `running` | running | Filled dot, `size-2.5`, `bg-kortix-green` |
| `stopped` | stopped, completed | Hollow ring, `size-2.5`, `border-[1.5px] border-muted-foreground` |
| `starting` | queued, branching, provisioning | Ring `size-2.5` `border-[1.5px] border-kortix-yellow` with a `size-1` `bg-kortix-yellow` centre dot, opacity pulse 1 → 0.35 (800ms, ease-in-out, repeats). Static under reduced motion |
| `failed` | failed | Diamond: `size-2 rotate-45 rounded-[1px] bg-destructive` |
| `needs-you` | pending review (not reachable on mobile yet) | `size-2` `bg-kortix-blue` dot inside a `size-4` `bg-kortix-blue/20` halo |

## 8. Colour and theme

- Every screen follows the resolved colour scheme (NativeWind `useColorScheme`).
  No screen is "always dark".
- Colours come from tokens (`bg-card`, `text-muted-foreground`, `THEME.*`).
  See `CLAUDE.md` → Color for the hex/rgba bans and `withAlpha`.
- Skia and other native renderers cannot parse `hsl(0 0% 100%)`; pass
  `withAlpha(token, 1)` (comma form) to them.

## 9. Checklist before handing off a screen

- [ ] Settings screen uses `SettingsPage` / `SettingsGroup` / `SettingsRow`
- [ ] No uppercase or letter-spaced group titles
- [ ] No row descriptions
- [ ] Chevrons `strokeWidth={2.75}`, full-width separators, borderless `rounded-2xl` cards
- [ ] Buttons follow section 2 (no sizing classes)
- [ ] Checked in light and dark mode
- [ ] `npx tsc --noEmit -p .` shows no new errors in the files you touched
