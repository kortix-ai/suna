# Kortix Mobile — design approach

Read this before building or restyling any screen in `apps/mobile`. It records
the patterns Jay has signed off on, with the exact values. `CLAUDE.md` in this
folder holds the primitive rules (which component to use); this file holds the
layout and visual decisions (how a screen looks).

When a rule here conflicts with an older screen, the rule wins. Convert the
screen when you touch it.

## 1. Settings screens

Every settings-style screen uses one layout, built from
`@/components/kortix/settings-list`: the `(settings)` stack (Settings, General,
Sounds, Notifications, Language), the Account tab, Accounts, and Billing. Do
not hand-roll headers, rows, dividers, or group titles.

| Export | Use |
| --- | --- |
| `SettingsHeader` | Back button + title + optional trailing action. `(settings)` screens get it from `_layout.tsx`; root-stack screens (`/accounts`, `/billing`) render it themselves with `Stack.Screen options={{ headerShown: false }}`; tab roots pass `showBack={false}` |
| `SettingsPage` | Scroll body. Tab roots pass `paddingBottom={useTabBarClearance()}` and `contentInsetAdjustmentBehavior={TAB_SCROLL_INSET_ADJUSTMENT}` |
| `SettingsGroup` | Titled, borderless rounded card with full-width separators |
| `SettingsRow` | icon (or `leading`) · label · trailing |
| `AppearanceToggle` | Light / Dark / System segmented control for an Appearance row's `right` |

```tsx
import { SettingsGroup, SettingsPage, SettingsRow } from '@/components/kortix/settings-list';

<SettingsPage>
  <SettingsGroup title="Preferences">
    <SettingsRow icon={User} label="General" onPress={() => go('/(settings)/general')} />
    <SettingsRow icon={Palette} label="Appearance" right={<ToggleGroup … />} />
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
| Content above groups | `header` prop (e.g. the profile avatar on General) |
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
| Description | **none**. Do not add a second line under the label |
| Chevron (navigates in-app) | `ChevronRight`, `size={16}`, `strokeWidth={2.75}` (semi-bold), `text-muted-foreground/70` — shown automatically when the row has `onPress` |
| External link (opens browser) | `external` prop → `ArrowUpRight`, same size and weight |
| Read-only value | `value` prop → muted text on the right, max 60% width, one line (e.g. the account email) |
| Inline control | `right` prop → `Switch`, `ToggleGroup`, check mark, icon button. Replaces the chevron |
| Selected option (picker) | `checked` prop → primary check mark. Picker rows also pass `right={null}` so no chevron shows (Sound pack, Language) |
| Active item that still navigates | `checked` + default chevron (the active account on Accounts) |
| Appearance | always `right={<AppearanceToggle />}` — never a separate appearance page |
| Destructive | `destructive` prop → icon and label `text-destructive` (Delete account, Sign out) |
| Badge | `badge` prop → small destructive pill after the label (e.g. "Scheduled") |
| Press feedback | background highlight `active:bg-accent`. Never scale a row inside a card |

### Account tab and account screens

| Screen | Structure |
| --- | --- |
| Account tab | profile block (avatar, name, email) → Preferences → Workspace → Help → **Advanced** (Delete account, Sign out — destructive, last). User settings has no Advanced group |
| Projects header | Kortix logo · search · New. No settings/avatar button — the Account tab owns settings |
| Account detail (`/accounts/[id]`) | `SettingsHeader title={account name}` + tab switcher (Members, Groups, Git, Audit, Settings). No avatar/name/"1 member · 1 project" block |
| Tab content | `SettingsPage`; primary action (Invite member, Create group, …) as the first row group; lists as titled groups of avatar/icon · name · value · chevron; row actions on the detail screen or an action sheet, never inline icon buttons |
| Detail screens (member, group) | `SettingsHeader title={name}`; destructive action alone at the bottom |
| Billing (`/billing`) | `SettingsPage hero={<BillingHero …/>}`: warm gradient (`THEME.accent.red` → `.orange` at low alpha over the theme background, diagonal sheen), centred transparent header with a help icon (Credits explained), balance label (`Text variant="large"`) + balance (`h1`, tabular), breakdown rows (label · semibold tabular value, no icons), one primary pill (`Button size="lg" rounded-full`, label left, chevron right). Sheet: Subscription, Purchases |

No subtitles, helper paragraphs, or meta lines anywhere on these screens.

| Pattern | Value |
| --- | --- |
| Accounts list | one untitled `SettingsGroup` — the header already says "Accounts" |
| Row ⋯ menu (Projects) | `ProjectActions`: bottom `Sheet` with the item's avatar + name and one untitled `SettingsGroup` of actions (Open project; Archive project, destructive, managers only). A destructive action confirms in an `AlertDialog` that opens after the sheet has closed — never two overlays at once |
| Android / web tab bar | `FloatingTabBar`, mirrors the iOS bar: 60pt capsule (`FLOATING_BAR_HEIGHT`), icon (20pt) over a 12px label, `bg-secondary` pill thumb behind the active tab, foreground icon + label on every tab. Light: `bg-background` + soft shadow; dark: `bg-card` + border |
| Push transition | Every stack (root, `(settings)`, `auth`) renders `AppStack` with `...usePushTransition()` from `components/navigation/stack-transitions`. iOS: native push. Android: JS card stack, layered and mirrored — push slides the new page in from the right edge over the current one (which shifts −30% and dims 10%), back slides it out to the right; 320ms open / 260ms close on `cubic-bezier(0.32, 0.72, 0, 1)`, soft leading-edge shadow; reduced motion → 150ms crossfade. Root swaps (auth ⇄ tabs) spread `fadeTransition`. No native Android animation is used: `default` fades the leaving page out on back, `ios_from_right` smears, `slide_from_right` is 400ms |
| Tab root headers | The Account tab has no screen header — the profile block is the top of the page (status-bar inset: automatic on iOS, `insets.top + 16` on Android) |
| Confirmations | `AlertDialog` (`rounded-3xl border-0` content; footer: destructive `Button size="lg" rounded-full` + `AlertDialogCancel asChild` secondary pill). Never `Alert.alert`. Sign out keeps the dialog open while it runs and shows a failure in the description |

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

## 4. Colour and theme

- Every screen follows the resolved colour scheme (NativeWind `useColorScheme`).
  No screen is "always dark".
- Colours come from tokens (`bg-card`, `text-muted-foreground`, `THEME.*`).
  See `CLAUDE.md` → Color for the hex/rgba bans and `withAlpha`.
- Skia and other native renderers cannot parse `hsl(0 0% 100%)`; pass
  `withAlpha(token, 1)` (comma form) to them.

## 5. Checklist before handing off a screen

- [ ] Settings screen uses `SettingsPage` / `SettingsGroup` / `SettingsRow`
- [ ] No uppercase or letter-spaced group titles
- [ ] No row descriptions
- [ ] Chevrons `strokeWidth={2.75}`, full-width separators, borderless `rounded-2xl` cards
- [ ] Buttons follow section 2 (no sizing classes)
- [ ] Checked in light and dark mode
- [ ] `npx tsc --noEmit -p .` shows no new errors in the files you touched
