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
project sidebar's avatar pushes the same page at `/account-settings`. There is
no `(settings)` index screen and no General page.

| Export | Use |
| --- | --- |
| `SettingsHeader` | Back button + title + optional trailing action. `(settings)` screens get it from `_layout.tsx`; root-stack screens (`/accounts`, `/billing`) render it themselves with `Stack.Screen options={{ headerShown: false }}`; tab roots pass `showBack={false}` |
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
| Padding | `px-4 py-3.5` |
| Icon | Lucide, `size={18}`, `strokeWidth={2.2}`, `text-foreground/80`, centred in a leading slot at least 20pt wide (`min-w-5`) so every label aligns. A row with no `icon` and no `leading` drops the slot and its `mr-3` gap, so its label starts at the card padding. A loading row keeps the slot with a `<Skeleton>` so its label does not shift |
| Custom leading | `leading` prop instead of `icon` — flag emoji (`Text variant="large"`) on Language, `Avatar variant="custom" size={28}` on Accounts |
| Label | `Text` default variant, one line, sentence case ("Edit profile", "Delete account") |
| Long label | `multiline` prop wraps the label instead of truncating it. Only for list content that is the label itself: plan features on Plans and the upgrade sheet (`Check` icon · feature). Never a way to add a description |
| Description | **none**. Do not add a second line under the label |
| Chevron (navigates in-app) | `ChevronRight`, `size={16}`, `strokeWidth={2.75}` (semi-bold), `text-muted-foreground/70` — shown automatically when the row has `onPress` |
| External link (opens browser) | `external` prop → `ArrowUpRight`, same size and weight |
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
| Account page (`AccountPage`) | `presentation="tab"` (Account tab): page title "Account" (`Text variant="h3"` in a 40pt row, part of the scroll content — no header bar, no logo, page background). `presentation="stack"` (`/account-settings`, from the project sidebar avatar): `SettingsHeader title="Account"` with Go back, no h3. Both then: profile header (80pt `ProfilePicture`, tap → system photo picker; 28pt camera badge `bg-secondary` with a 2pt `border-background` ring at the bottom-right; `KortixLoader size="small"` over the photo while uploading; display name `Text variant="large"` centred below) → one untitled group (no icon · email · `PricingTierBadge size="md"` for the active account's plan, always shown: `plan.label` from the API, else `tier_display_name`; no icon · Edit profile → `EditProfileSheet`) → Preferences (Appearance, Sounds, Notifications, Language) → Workspace (Accounts, Billing) → Help → **Advanced** (Delete account, Sign out — destructive, last) |
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
| Project stack | `/projects/[id]` is a nested stack: `app/projects/[id]/_layout.tsx` renders `ProjectScreen`, `index` is project home, `view` is the open page, thread, or connecting session (`components/session/ProjectRoutes`). Back from the view (Go back, iOS swipe, Android back) → project home. Back from project home does nothing: `projects/[id]` has `gestureEnabled: false`, a project always opens with `router.replace` so no screen sits under it, and Android back there is left to the system. The Projects list opens only from the project menu (All projects, `router.replace('/projects')`). Opening another page or thread while the view is open swaps its content; the stack never grows deeper. A page header (`PageHeader` inside `PageBackProvider`), a thread, and a connecting session show Go back (`PlatformButton chevron.left`) in place of the hamburger; the drawer opens from project home. A project always opens on project home: the tab store neither restores nor persists the active page or thread |
| App start | `app/index.tsx` is the door (web `/projects/start`): signed out → `/auth`; signed in → the last project this user opened (`useLastProjectStore`, keyed by user id), else the first project (`lib/projects/landing.ts`: selected account, then owned/admin, then member accounts), via `router.replace`. The Projects list only when no account has a project. Network failure: 2 retries, then "Could not open your project" + Try again, never the list. Every implicit redirect (sign-in, back with no history, leaving an account) goes to `/`, never `/projects` |
| Push transition | Every stack (root, `(settings)`, `auth`, project) renders `AppStack` with `...usePushTransition()` from `components/navigation/stack-transitions`. iOS: native push. Android: JS card stack, layered and mirrored — push slides the new page in from the right edge over the current one (which shifts −30% and dims 10%), back slides it out to the right; 320ms open / 260ms close on `cubic-bezier(0.32, 0.72, 0, 1)`, soft leading-edge shadow; reduced motion → 150ms crossfade. Root swaps (auth ⇄ tabs) spread `fadeTransition`. No native Android animation is used: `default` fades the leaving page out on back, `ios_from_right` smears, `slide_from_right` is 400ms |
| Tab root headers | The Account tab has no screen header — the profile block is the top of the page (status-bar inset: automatic on iOS, `insets.top + 16` on Android) |
| Confirmations | `AlertDialog` (`rounded-3xl` content — `Dialog` and `AlertDialog` are borderless in the primitives, on `bg-popover` — the same surface as bottom sheets — over a `bg-black/70` overlay; call sites never set a background; footer: destructive `Button size="lg" rounded-full` + `AlertDialogCancel asChild` secondary pill). Never `Alert.alert`. Sign out, Delete account, and Keep current plan keep the dialog open while they run and show a failure in the description. Delete account always asks for a typed confirm word and then a second question with a delayed Delete button (both timings); taps alone never delete. Keep current plan confirms with the buttons alone, and a safe action (Cancel deletion) does not confirm |
| Results | Success of an action that leaves the page in place → `useToast().success`; a failure outside a dialog → `useToast().error`. Never `Alert.alert` |

### Copy

- Labels name the destination or setting in 1–2 words, sentence case.
- Group titles group by user intent: Preferences, Profile, Account, Help,
  Advanced, Sound pack, Sound events, Feedback.
- Destructive actions live in their own group at the bottom (Advanced / Account).

## 2. Buttons

| Situation | Use |
| --- | --- |
| Primary header action (e.g. projects "New") and screen back buttons | `PlatformButton` — native iOS SwiftUI button (plain style, `secondary` fill, no glass), design-system pill on Android |
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

## 3. Auth screens

| Element | Value |
| --- | --- |
| Welcome | full-bleed `KortixCurrents` hero, logomark, provider pills (`size="lg"`, `rounded-full`), provider icon pinned to the pill's left edge |
| Email screen | back `PlatformButton`-style header, `PillInput` fields (44pt, matches `Button size="lg"`), primary pill, bottom pinned secondary pills + legal links |
| Fields | `PillInput` on full screens, `SheetTextInput` inside bottom sheets — never `<Input>` restyled by class |

## 4. Project home

`/projects/[id]` with no chat open (`components/session/ProjectHome.tsx`,
COR-34). It matches the web project home: simple and clean, nothing extra.

| Element | Value |
| --- | --- |
| Greeting | `ProjectGreeting`: `KortixLogo` (38pt) over one sentence, `gap-4`. Centred on the screen; centred in the area above the keyboard while typing |
| Message | Always "Give {project name} something real to work on." (web `HOME_GREETINGS[0]`, pinned by `lib/session/project-greeting.test.ts`). No rotation, no variants. `Text variant="lead"`, centred; the name is `text-foreground`, the rest muted. Unknown name → "it" |
| Chat input | `Composer`: one borderless `rounded-3xl` card (light `bg-background` + `LIGHT_SHADOW`, dark `bg-card`). Text field on top (16pt Roobert, plain "Ask anything" placeholder, no animation). Row below: add (`Button variant="secondary" size="icon"`, `+`) · model pill (`Button variant="secondary"`, model name) · spacer · send (`Button size="icon"`, secondary when empty, primary when there is something to send). All `rounded-full` |
| Chat input position | Pinned to the bottom with `px-3`, above the dock (`insets.bottom + 72`); follows the keyboard to 8pt above it. Text, files, and model stay until the send succeeds |
| Add (`+`) | `useAttachmentPicker`: photo library, camera (iOS), files. Files show as chips (thumbnail · name · remove). They upload after the new session connects |
| Model pill | Project gateway catalog (`useProjectModelCatalog`), label = the pick or the project default. Opens `ModelPickerSheet` (one `SettingsGroup` of checked rows). Sent as `opencode_model`. Hidden when the project has no LLM gateway |
| Chrome | Floating menu button (top left) and the project dock. They belong to the project screen, not to the home |
| Never | Starter chips, recent-session lists, cards, widgets, subtitles |
| New chat, no messages | `SessionPage`'s `FreshSessionHero` renders the same `ProjectGreeting` |

## 5. Colour and theme

- Every screen follows the resolved colour scheme (NativeWind `useColorScheme`).
  No screen is "always dark".
- Colours come from tokens (`bg-card`, `text-muted-foreground`, `THEME.*`).
  See `CLAUDE.md` → Color for the hex/rgba bans and `withAlpha`.
- Skia and other native renderers cannot parse `hsl(0 0% 100%)`; pass
  `withAlpha(token, 1)` (comma form) to them.

## 6. Checklist before handing off a screen

- [ ] Settings screen uses `SettingsPage` / `SettingsGroup` / `SettingsRow`
- [ ] No uppercase or letter-spaced group titles
- [ ] No row descriptions
- [ ] Chevrons `strokeWidth={2.75}`, full-width separators, borderless `rounded-2xl` cards
- [ ] Buttons follow section 2 (no sizing classes)
- [ ] Checked in light and dark mode
- [ ] `npx tsc --noEmit -p .` shows no new errors in the files you touched
