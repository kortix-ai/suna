# `/download` — public download page

**Date:** 2026-07-31
**Branch:** `download` (worktree `/Users/jay/root/kortix/suna-download`)
**Linear project:** Kortix download (team `Jay`)

## Problem

Kortix ships four consumer surfaces — desktop app, CLI, iOS, Android — and has no
public page that hands a visitor the right file. Today:

- `/download` is a **route handler** that 302s straight to a GitHub asset. A
  visitor who types `kortix.com/download` gets a 195 MB file with no page, no
  version, no size, and no way to pick a different platform.
- The only real download UI is `DownloadAppsModal`
  (`apps/web/src/features/layout/download-apps-modal.tsx`), which is **inside the
  authenticated app**. A logged-out visitor cannot reach it.
- That modal carries six `shadow-[…]` declarations and `rounded-3xl` containers,
  both of which the design system forbids for in-flow surfaces.

A non-technical visitor has no supported path to installing Kortix.

## Goal

One public page at `/download` that gives any visitor — technical or not — the
correct file in one click.

**The recommendation mechanic:** exactly one filled button exists on the page,
and it is the visitor's own platform. Every other button is `outline`. The
visitor does not read a matrix and decide; they click the black button.

## Verified inventory

Everything below is read from the live GitHub release, not from docs.
Source: `https://api.github.com/repos/kortix-ai/suna/releases/latest`,
tag `v0.11.0`, published 2026-07-28.

| Artifact | Platform | Size |
| --- | --- | --- |
| `Kortix-0.11.0-universal.dmg` | macOS (Apple Silicon + Intel) | 195.3 MB |
| `Kortix-Setup-0.11.0.exe` | Windows x64 | 91.6 MB |
| `Kortix-0.11.0-x86_64.AppImage` | Linux x86_64 | 110.5 MB |
| `kortix-darwin-arm64` | CLI, macOS Apple Silicon | 66.5 MB |
| `kortix-darwin-x64` | CLI, macOS Intel | 71.9 MB |
| `kortix-linux-arm64` | CLI, Linux ARM64 | 95.3 MB |
| `kortix-linux-x64` | CLI, Linux x64 | 96.1 MB |

Mobile (live, not in the GitHub release):

- iOS — `https://apps.apple.com/ie/app/kortix/id6754448524`
- Android — `https://play.google.com/store/apps/details?id=com.kortix.app`

### Two gaps the page must state, not hide

1. **No Linux arm64 desktop build exists.** Only `x86_64.AppImage` ships. The
   Linux row is labelled `AppImage · x86_64` so an ARM visitor is not misled.
2. **No Windows CLI binary exists.** The install script is `bash`-only. The
   Terminal block is labelled `macOS & Linux · WSL on Windows` rather than
   handing a Windows visitor a command that fails.

### Removed from scope

There is no Chrome extension in the repo — no `manifest.json`, no `apps/*chrome*`.
The v1 draft carried a disabled "Coming soon" card for it. **It is deleted.** A
download page advertising a thing that cannot be downloaded is noise.

## Layout

Two image-led cards, then one terminal block. Card anatomy is taken from the
Perplexity download page: full-bleed product image, then title and description,
then a divided list of platform rows, each row ending in its own button.

```
                        Download Kortix
          Get the app for your desktop, phone, or terminal.

┌────────────────────────────────┐  ┌────────────────────────────────┐
│ ▓▓▓ product poster 16:10 ▓▓▓▓▓ │  │ ▓▓▓ three phone shots ▓▓▓▓▓▓▓▓ │
├────────────────────────────────┤  ├────────────────────────────────┤
│ Desktop app                    │  │ Mobile app                     │
│ Run Kortix on your own machine │  │ Start a session anywhere and   │
│ with your files and terminal.  │  │ pick up where you left off.    │
├────────────────────────────────┤  ├────────────────────────────────┤
│  macOS             [Download] ←│  │  iPhone and iPad   [Download]  │
│  Universal · 195 MB     FILLED │  │  App Store            outline  │
├────────────────────────────────┤  ├────────────────────────────────┤
│  Windows           [Download]  │  │  Android           [Download]  │
│  64-bit · 92 MB        outline │  │  Google Play          outline  │
├────────────────────────────────┤  └────────────────────────────────┘
│  Linux             [Download]  │
│  AppImage · x86_64 · 111 MB    │
└────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│ Terminal · macOS & Linux · WSL on Windows                        │
│  curl -fsSL https://kortix.com/install.sh | bash        [copy]   │
└──────────────────────────────────────────────────────────────────┘
```

Page container is `max-w-5xl`. The cards are `md:grid-cols-2`; they stack on
mobile. The terminal block is always full width — it holds a command, not a
button, so it needs the horizontal room and has no second column to pair with.

**No "All downloads" matrix.** The v1 draft carried a three-column table of every
artifact below the fold. It is cut. The `curl` script already resolves platform
and architecture on its own, so no install path is lost, and the
`/download/cli/<target>` routes stay live for anyone linking a specific binary.

## Decisions

### D1 — Page at `/download`, redirectors at `/download/<platform>`

Next.js App Router forbids `page.tsx` and `route.ts` in the same segment. The
human page takes the segment root; the machine endpoints move one level down:

- `/download` → page (new)
- `/download/macos`, `/download/windows`, `/download/linux` → 302 to the asset

Rejected: `?platform=` query strings (not hand-writable), and `/downloads`
(plural) (the ask was `/download`).

**No middleware change is required.** `apps/web/src/middleware.ts:216` matches
public routes with `pathname === route || pathname.startsWith(route + '/')`, so
the existing `'/download'` allowlist entry already covers the child segments.

Bookmarks on bare `/download` now land on a page instead of firing a 195 MB
download. This is the intended improvement, not a regression. Nothing
machine-critical depends on the old behaviour: `apps/desktop-electron`
auto-updates against `latest.yml` on GitHub, and only mentions `/download` in a
comment describing the manual human fallback.

### D2 — Detection is server-side, and covers five platforms

The page reads the `user-agent` request header in a Server Component and renders
the correct card order and the correct filled button on first paint.

`detect-os.ts` widens from `DesktopOs` (3 values) to `Platform` (5):
`macos | windows | linux | ios | android`.

Ordering rules, in one place:

| Detected | Card order | Filled button |
| --- | --- | --- |
| `macos` | Desktop, Mobile | Desktop → macOS |
| `windows` | Desktop, Mobile | Desktop → Windows |
| `linux` | Desktop, Mobile | Desktop → Linux |
| `ios` | **Mobile**, Desktop | Mobile → iPhone and iPad |
| `android` | **Mobile**, Desktop | Mobile → Android |

Within a card the detected row hoists to the top. Across cards, a mobile
detection hoists the whole Mobile card above the Desktop card. Exactly one
filled button renders in every one of the five cases.

Detection order is load-bearing, and it is not alphabetical. Two real traps:

- `Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)` contains **`mac`**. Testing
  macOS first classifies every iPad as a Mac.
- `Mozilla/5.0 (Linux; Android 14; Pixel 8)` contains **`linux`**. Testing Linux
  first classifies every Android phone as a desktop Linux box.

So the order is: iOS → Android → Windows → macOS → Linux.

**Accepted limitation:** an iPad with "Request Desktop Website" on sends a UA
that is byte-identical to a Mac's. No server can tell them apart; real detection
needs `navigator.maxTouchPoints`, which does not exist in a request header. That
visitor sees the Desktop card first with macOS filled. This is not worth a
client-side hydration swap — the Mobile card is still on the page, one tap away,
and the swap would reintroduce the wrong-file-click window that D2 exists to
close.

Rejected: `useEffect` + `navigator.userAgent`. It paints the wrong order, then
swaps. A visitor who clicks during that window downloads the wrong file — the
exact failure this page exists to prevent.

Cost: the route renders dynamically. Accepted; it already needs live release
data.

Architecture is deliberately **not** detected. macOS ships a universal `.dmg`,
and macOS user agents misreport arch anyway (they always claim Intel).

### D3 — One shared asset resolver

`features/marketing/download/releases.ts` owns the GitHub fetch and asset
matching. **Both the page and the redirect route handler import it.** Version,
size, and filename therefore cannot disagree between what the page displays and
what the button delivers.

Fetch uses `next: { revalidate: 600 }`, the same TTL as the current route, so
GitHub's rate limit is not hit per click.

### D4 — Degrade honestly

If the GitHub API fails or rate-limits, `getLatestRelease()` returns `null`. Each
row then omits its size from the meta line and still renders its button. The
buttons point at `/download/<platform>`, which falls back to the releases page on
its own. **No error state, no broken button, no placeholder text.**

### D5 — Delete `DownloadAppsModal`

The in-app "Download apps" entries in `user-menu.tsx` and `app-header.tsx`
navigate to `/download`. The modal file is deleted.

Removes ~390 lines, six shadow violations, and a second divergent download UI.

### D6 — Zero shadows

Every surface is `bg-popover rounded-md border`. No `shadow-*` class anywhere in
the new code, including on the images inside the card headers. This is already
design-system law — "in-flow surfaces get a border, not a shadow" — and the
deleted modal was the violation.

### D7 — Card images are existing assets, paired by theme

Both card images already ship in `apps/web/public`. Nothing is captured or
generated:

| Card | Asset | Notes |
| --- | --- | --- |
| Desktop | `/media/showcase/kortix-showcase-poster.jpg` + `-dark-poster.jpg` | 1920×1200, 96 KB each. Real app, both palettes, same session. |
| Mobile | `/images/mobile-app/app-{1,2,3}.png` | 1080×2337 each. Composed as three phones in a 16:10 box. |

The desktop pair is toggled with `dark:hidden` / `hidden dark:block`, **not**
`<picture media="(prefers-color-scheme: dark)">`. A `media` attribute resolves
once at load, so it is correct on first paint and permanently wrong after the
visitor uses the app's own theme toggle. CSS class toggling costs both files
(192 KB total) and follows the toggle forever. It also needs no hook, which is
what keeps the page a Server Component.

The mobile phones sit in the image box with a `border`, never a `shadow` — the
existing `MobileSurface` treatment uses `shadow-md`, and that part is not
carried over.

## Components

| Path | Kind | Responsibility |
| --- | --- | --- |
| `app/(public)/(marketing)/download/page.tsx` | Server | Reads UA header, fetches release, orders the two cards, exports `metadata` |
| `app/(utility)/download/[platform]/route.ts` | Route | 302 to the resolved asset; falls back to the releases page |
| `app/(utility)/download/cli/[target]/route.ts` | Route | 302 to a specific CLI binary (unchanged) |
| `features/marketing/download/content.ts` | Data | All copy; the row definitions for both cards |
| `features/marketing/download/releases.ts` | Data | `getLatestRelease()`, `pickDesktopAsset()`, `pickCliAsset()`, `formatSize()` |
| `features/marketing/download/detect-os.ts` | Pure | `detectPlatform(ua)`, `normalizePlatform()`, `orderedDesktopOs()`, `orderedMobileOs()`, `isMobile()` |
| `features/marketing/download/platform-card.tsx` | Server | The card shell: image slot, header slot, divided rows |
| `features/marketing/download/terminal-block.tsx` | Client | Install command + `CopyButton` |

Deleted: `desktop-hero.tsx`, `surface-cards.tsx`, `all-downloads.tsx`,
`terminal-card.tsx`.

The page stays a Server Component. Only the terminal block is a client island,
because `useDeploymentCliInstallCommand` reads `window.location.origin` via
`useSyncExternalStore` to build the install command for the current deployment.

`CopyButton` (`components/markdown/copy-button.tsx`) is reused verbatim — it
already implements the mandated blur + scale + opacity icon crossfade. No new
copy-state logic is written.

Navbar and Footer are inherited from `app/(public)/(marketing)/layout.tsx`.

## Testing

Unit (co-located `bun:test`, per the repo testing skill):

- `detect-os.test.ts` — all five platforms from real UA strings, plus the two
  ordering traps stated in D2: a mobile-mode iPad UA must return `ios` not
  `macos`, and an Android UA must return `android` not `linux`. Also empty UA,
  garbage UA, and both ordering helpers for all five detected values.
- `releases.test.ts` — picks universal `.dmg` over per-arch, picks `.exe`, picks
  `.AppImage`, picks the right CLI binary per platform+arch, returns `undefined`
  on an empty asset list.

Real-surface verification (required before merge):

This worktree is slot 13: web `14300`, api `14308`.

1. `curl -sI localhost:14300/download/macos` → `302` with a `location` ending
   `Kortix-<version>-universal.dmg`. Repeat for `windows` and `linux`.
2. `curl -s localhost:14300/download -H 'User-Agent: <UA>'` for all five
   platforms → the served HTML contains the correct card order and the filled
   button on the correct row **in the initial payload**, proving no client flash.
3. Drive `/download` in a browser: assert the primary button's `href`, assert
   zero `shadow` computed on every card and row element, screenshot light + dark
   at desktop and mobile widths.
4. `npx eslint <files>` clean; `tsc --noEmit` clean for the new files only
   (`apps/web` emits ~1500 unrelated `TS2786` errors from the React 19↔18 types
   mismatch).

## Out of scope

- Building a Chrome extension.
- Publishing a Linux arm64 AppImage or a Windows CLI binary. The page labels the
  gaps; closing them is a release-pipeline change.
- i18n. Copy lives in `content.ts` as plain English, matching the `/self-hosted`
  precedent, and is wired to translation keys only once locked.
