# `/download` Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship one public `/download` page that hands any visitor the correct
installer in a single click, using two image-led cards and a terminal block.

**Architecture:** A Next.js Server Component reads the request `user-agent`,
resolves a `Platform`, and orders two `PlatformCard`s so the visitor's own
platform is the first row of the first card and carries the only filled button
on the page. Release metadata comes from one shared GitHub resolver that the
`/download/<platform>` 302 handlers also import, so the printed size can never
disagree with the delivered bytes.

**Tech Stack:** Next.js App Router (RSC), React 19, Tailwind v4, `bun:test`,
`@phosphor-icons/react` via `@/lib/icons/ssr`, `motion/react` (inside the reused
`CopyButton` only).

**Spec:** `docs/superpowers/specs/2026-07-31-download-page-design.md`

**Supersedes:** the v1 plan of the same name, which built a centred hero button,
a three-card surface row including a Chrome "coming soon" tease, and an
"All downloads" matrix. All three are cut.

## Global Constraints

- **Worktree:** all work happens in `/Users/jay/root/kortix/suna-download` on
  branch `download`. Slot 13 — web `14300`, api `14308`.
- **Zero shadows.** No `shadow-*` class in any new or edited file on this branch,
  including on images. In-flow surfaces get a border.
- **Radius:** `rounded-md` on cards and panels. Never `rounded-xl`/`rounded-2xl`
  on a container. No nested rounding (parent and child both rounded).
- **Padding never sits on a bordered element that hosts flush children.** The
  card element itself is unpadded; its image slot, header slot, and rows carry
  their own padding, so `border-t` seams run edge to edge.
- **Icons:** Phosphor only, imported from `@/lib/icons/ssr` in server components
  and `@phosphor-icons/react` in client components. Never pass a `weight` prop.
- **Color:** semantic tokens and `kortix-*` only. No raw Tailwind palette
  (`bg-blue-500`), no hex, no manual `dark:` palette hacks.
- **Buttons:** `@/components/ui/marketing/button`. `variant="default"` is the
  single filled button; every other button on the page is `variant="outline"`.
- **Exactly one filled button renders on the page**, in all five detection cases.
- **No Chrome extension surface.** No "coming soon" card, no `ChromeMark` import.
- **No "All downloads" matrix.**
- **Copy accuracy gate:** Linux desktop is `x86_64` only; there is no Windows CLI
  binary. Never advertise either.
- **Never commit unless explicitly asked.**

---

### Task 1: Widen platform detection to five platforms

**Files:**
- Modify: `apps/web/src/features/marketing/download/detect-os.ts`
- Test: `apps/web/src/features/marketing/download/detect-os.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type DesktopOs = 'macos'|'windows'|'linux'`,
  `type MobileOs = 'ios'|'android'`, `type Platform = DesktopOs | MobileOs`,
  `detectPlatform(ua: string|null|undefined): Platform`,
  `normalizePlatform(raw: string|null|undefined): Platform | null`,
  `isMobilePlatform(p: Platform): p is MobileOs`,
  `orderedDesktop(p: Platform): DesktopOs[]`,
  `orderedMobile(p: Platform): MobileOs[]`.
  Tasks 2, 3 and 5 all import from here.

- [ ] **Step 1: Replace the test file**

```ts
import { describe, expect, it } from 'bun:test';
import {
  detectPlatform, isMobilePlatform, normalizePlatform, orderedDesktop, orderedMobile,
} from './detect-os';

const UA = {
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36',
};

describe('detectPlatform', () => {
  it('reads each platform from a real user agent', () => {
    expect(detectPlatform(UA.mac)).toBe('macos');
    expect(detectPlatform(UA.windows)).toBe('windows');
    expect(detectPlatform(UA.linux)).toBe('linux');
    expect(detectPlatform(UA.iphone)).toBe('ios');
    expect(detectPlatform(UA.android)).toBe('android');
  });

  // Both of these UAs contain another platform's token. If the checks in
  // detectPlatform are reordered, these are the tests that fail.
  it('does not read an iPad as a Mac (its UA contains "Mac OS X")', () => {
    expect(UA.ipad.toLowerCase()).toContain('mac');
    expect(detectPlatform(UA.ipad)).toBe('ios');
  });

  it('does not read an Android phone as desktop Linux (its UA contains "Linux")', () => {
    expect(UA.android.toLowerCase()).toContain('linux');
    expect(detectPlatform(UA.android)).toBe('android');
  });

  it('falls back to macOS on an absent or unparseable user agent', () => {
    expect(detectPlatform(null)).toBe('macos');
    expect(detectPlatform(undefined)).toBe('macos');
    expect(detectPlatform('')).toBe('macos');
    expect(detectPlatform('curl/8.4.0')).toBe('macos');
  });
});

describe('normalizePlatform', () => {
  it('maps aliases used in /download/<segment> and ?platform=', () => {
    expect(normalizePlatform('mac')).toBe('macos');
    expect(normalizePlatform('Darwin')).toBe('macos');
    expect(normalizePlatform('win')).toBe('windows');
    expect(normalizePlatform('ios')).toBe('ios');
    expect(normalizePlatform('android')).toBe('android');
  });

  it('returns null for anything it does not recognise', () => {
    expect(normalizePlatform('freebsd')).toBeNull();
    expect(normalizePlatform('')).toBeNull();
    expect(normalizePlatform(null)).toBeNull();
  });
});

describe('ordering', () => {
  it('hoists the detected desktop OS to the front, keeping the rest canonical', () => {
    expect(orderedDesktop('windows')).toEqual(['windows', 'macos', 'linux']);
    expect(orderedDesktop('linux')).toEqual(['linux', 'macos', 'windows']);
    expect(orderedDesktop('macos')).toEqual(['macos', 'windows', 'linux']);
  });

  it('leaves the desktop order canonical when a phone is detected', () => {
    expect(orderedDesktop('ios')).toEqual(['macos', 'windows', 'linux']);
    expect(orderedDesktop('android')).toEqual(['macos', 'windows', 'linux']);
  });

  it('hoists the detected mobile OS and is canonical otherwise', () => {
    expect(orderedMobile('android')).toEqual(['android', 'ios']);
    expect(orderedMobile('ios')).toEqual(['ios', 'android']);
    expect(orderedMobile('macos')).toEqual(['ios', 'android']);
  });

  it('classifies which platforms are phones', () => {
    expect(isMobilePlatform('ios')).toBe(true);
    expect(isMobilePlatform('android')).toBe(true);
    expect(isMobilePlatform('macos')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
cd apps/web && bun test src/features/marketing/download/detect-os.test.ts
```

Expected: FAIL — `detectPlatform`, `orderedDesktop`, `orderedMobile` and
`isMobilePlatform` are not exported.

- [ ] **Step 3: Rewrite `detect-os.ts`**

```ts
/**
 * Platform detection for the /download page and the per-platform redirect
 * routes.
 *
 * Detection runs on the SERVER, from the request's user-agent header, so the
 * page paints the correct card order and the correct filled button on first
 * render. A client-side `useEffect` swap would let a visitor click the wrong
 * installer during the flash — the exact failure this page exists to prevent.
 *
 * Architecture is deliberately NOT detected: macOS ships a single universal
 * .dmg, and macOS user agents misreport arch anyway (they always claim Intel).
 */

export type DesktopOs = 'macos' | 'windows' | 'linux';
export type MobileOs = 'ios' | 'android';
export type Platform = DesktopOs | MobileOs;

/** Canonical order, used once the detected platform has been hoisted out. */
export const DESKTOP_ORDER: readonly DesktopOs[] = ['macos', 'windows', 'linux'];
export const MOBILE_ORDER: readonly MobileOs[] = ['ios', 'android'];

const PLATFORM_ALIASES: Record<string, Platform> = {
  mac: 'macos', macos: 'macos', osx: 'macos', darwin: 'macos', apple: 'macos',
  win: 'windows', windows: 'windows',
  linux: 'linux',
  ios: 'ios', iphone: 'ios', ipad: 'ios',
  android: 'android',
};

/** Map an explicit `?platform=` value or `/download/<segment>` to a platform. */
export function normalizePlatform(raw: string | null | undefined): Platform | null {
  return PLATFORM_ALIASES[(raw || '').toLowerCase()] ?? null;
}

/**
 * Best-effort platform from a user-agent string.
 *
 * THE ORDER OF THESE CHECKS IS LOAD-BEARING. Two user agents carry another
 * platform's token:
 *   iPad     "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)"  contains "mac"
 *   Android  "Mozilla/5.0 (Linux; Android 14; Pixel 8)"       contains "linux"
 * So iOS is tested before macOS, and Android before Linux. `detect-os.test.ts`
 * pins both; if you reorder these lines, those tests fail.
 *
 * KNOWN LIMITATION: an iPad with "Request Desktop Website" enabled sends a UA
 * byte-identical to a Mac's. No server can separate them — real detection needs
 * `navigator.maxTouchPoints`, which is not in any request header. That visitor
 * gets the Desktop card first; the Mobile card is still on the page, one tap
 * away. Fixing it client-side would reintroduce the wrong-file-click window
 * this module exists to close.
 *
 * Defaults to macOS: the largest desktop segment for this product, and every
 * other platform stays one click away on the page.
 */
export function detectPlatform(userAgent: string | null | undefined): Platform {
  const ua = (userAgent || '').toLowerCase();
  if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ipod')) return 'ios';
  if (ua.includes('android')) return 'android';
  if (ua.includes('windows')) return 'windows';
  if (ua.includes('mac') || ua.includes('darwin')) return 'macos';
  if (ua.includes('linux')) return 'linux';
  return 'macos';
}

export function isMobilePlatform(platform: Platform): platform is MobileOs {
  return platform === 'ios' || platform === 'android';
}

/** Detected desktop OS first. A phone detection leaves the order canonical. */
export function orderedDesktop(platform: Platform): DesktopOs[] {
  if (isMobilePlatform(platform)) return [...DESKTOP_ORDER];
  return [platform, ...DESKTOP_ORDER.filter((os) => os !== platform)];
}

/** Detected mobile OS first. A desktop detection leaves the order canonical. */
export function orderedMobile(platform: Platform): MobileOs[] {
  if (!isMobilePlatform(platform)) return [...MOBILE_ORDER];
  return [platform, ...MOBILE_ORDER.filter((os) => os !== platform)];
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
cd apps/web && bun test src/features/marketing/download/detect-os.test.ts
```

Expected: PASS, every case.

- [ ] **Step 5: Constrain the redirect handler to desktop platforms**

`normalizePlatform` now widens to `Platform`, so `/download/ios` would otherwise
reach `pickDesktopAsset`, which only understands desktop values. In
`apps/web/src/app/(utility)/download/[platform]/route.ts`, reject mobile values
the same way an unknown value is already rejected:

```ts
const os = normalizePlatform(platform);
if (!os || os === 'ios' || os === 'android') {
  return NextResponse.redirect(RELEASES_PAGE, 302);
}
```

Match the file's existing redirect idiom rather than pasting this verbatim — read
it first and keep its style.

- [ ] **Step 6: Run every test that touches detection**

```bash
cd apps/web && bun test src/features/marketing/download 'src/app/(utility)/download'
```

Expected: PASS. If `route.test.ts` asserted a mobile segment's old behaviour,
update that assertion to the new redirect and say so.

---

### Task 2: Row content for both cards

**Files:**
- Modify: `apps/web/src/features/marketing/download/content.ts`

**Interfaces:**
- Consumes: `DesktopOs`, `MobileOs` from Task 1.
- Produces: `hero`, `DESKTOP_CARD`, `MOBILE_CARD`, `TERMINAL`,
  `type CardCopy = { title: string; description: string }`,
  `type RowCopy = { label: string; hint: string; href: string }`,
  `DESKTOP_ROWS: Record<DesktopOs, RowCopy>`,
  `MOBILE_ROWS: Record<MobileOs, RowCopy>`.
  Tasks 4 and 5 compose from these.

- [ ] **Step 1: Replace the matrix with row definitions**

Delete `MATRIX`, `MatrixRow`, `MatrixColumn`, `OS_LABELS`, `OS_HINTS` and
`MOBILE`. Write:

```ts
/**
 * `/download` copy.
 *
 * Plain English lives here, not in `apps/web/translations/*.json`, so copy can
 * iterate before paying the 8-locale parity gate. Same precedent as
 * `features/marketing/self-hosted/content.ts`.
 *
 * ACCURACY GATE — every string below is checked against the live GitHub release
 * (v0.11.0, 2026-07-28), not against docs:
 *  1. macOS ships ONE universal .dmg. Never advertise separate Apple Silicon
 *     and Intel desktop builds — they do not exist.
 *  2. Linux desktop is x86_64 ONLY. There is no arm64 AppImage. The row says so.
 *  3. There is NO Windows CLI binary. The install script is bash-only, so the
 *     terminal block says "macOS & Linux · WSL on Windows".
 */

import type { DesktopOs, MobileOs } from './detect-os';

export const hero = {
  title: 'Download Kortix',
  sub: 'Get the app for your desktop, your phone, or your terminal.',
};

export type CardCopy = { title: string; description: string };
export type RowCopy = { label: string; hint: string; href: string };

export const DESKTOP_CARD: CardCopy = {
  title: 'Desktop app',
  description: 'Run Kortix on your own machine, with your files and your terminal.',
};

export const MOBILE_CARD: CardCopy = {
  title: 'Mobile app',
  description: 'Start a session anywhere and pick up where you left off.',
};

/**
 * `hint` is the line under the label. Size is appended at render from the live
 * release, so it disappears rather than lying when GitHub is unreachable.
 */
export const DESKTOP_ROWS: Record<DesktopOs, RowCopy> = {
  macos: { label: 'macOS', hint: 'Universal', href: '/download/macos' },
  windows: { label: 'Windows', hint: '64-bit', href: '/download/windows' },
  linux: { label: 'Linux', hint: 'AppImage · x86_64', href: '/download/linux' },
};

export const MOBILE_ROWS: Record<MobileOs, RowCopy> = {
  ios: {
    label: 'iPhone and iPad',
    hint: 'App Store',
    href: 'https://apps.apple.com/ie/app/kortix/id6754448524',
  },
  android: {
    label: 'Android',
    hint: 'Google Play',
    href: 'https://play.google.com/store/apps/details?id=com.kortix.app',
  },
};

export const TERMINAL = {
  title: 'Terminal',
  description: 'Install the CLI and drive Kortix from your shell.',
  support: 'macOS & Linux · WSL on Windows',
};
```

- [ ] **Step 2: Confirm nothing outside the doomed files imports the old names**

```bash
cd apps/web && grep -rn "MATRIX\|OS_LABELS\|OS_HINTS\|MatrixColumn" src/ || echo clean
```

Expected: hits only in `desktop-hero.tsx`, `surface-cards.tsx` and
`all-downloads.tsx`, all of which Task 5 deletes. Any other file means an
unplanned consumer — stop and report it.

---

### Task 3: The `PlatformCard` shell

**Files:**
- Create: `apps/web/src/features/marketing/download/platform-card.tsx`

**Interfaces:**
- Consumes: `Platform` (Task 1).
- Produces: `PlatformCard({ image, title, description, rows, filled })` and
  `type CardRow = { id: Platform; label: string; meta: string; href: string;
  external?: boolean; Mark: React.ComponentType<{ className?: string }> }`.
  Task 5 renders it twice.

- [ ] **Step 1: Write the component**

```tsx
import { Button } from '@/components/ui/marketing/button';
import Link from 'next/link';

import type { Platform } from './detect-os';

export type CardRow = {
  id: Platform;
  label: string;
  /** Line under the label, e.g. "Universal · 195 MB". Empty renders nothing. */
  meta: string;
  href: string;
  /** Store links leave the site; the platform redirects do not. */
  external?: boolean;
  Mark: React.ComponentType<{ className?: string }>;
};

/**
 * One product card: full-bleed image, header, then a divided list of platform
 * rows. Modelled on the Perplexity download page.
 *
 * The card element itself carries NO padding — it hosts flush children (the
 * image and the row seams), so padding lives on the slots. That is what lets
 * `border-t` run edge to edge instead of floating inside a gutter.
 *
 * Flat by law: border, never a shadow. In-flow surfaces do not float.
 *
 * `filled` names the one row whose button is `default` (solid). Every other
 * button on the page is `outline`. Exactly one solid button exists per page and
 * it is the visitor's own platform — that is the entire recommendation UI.
 */
export function PlatformCard({
  image,
  title,
  description,
  rows,
  filled,
}: {
  image: React.ReactNode;
  title: string;
  description: string;
  rows: CardRow[];
  filled: Platform | null;
}) {
  return (
    <section className="bg-popover flex flex-col overflow-hidden rounded-md border">
      {image}

      <div className="px-5 pt-5 pb-4">
        <h2 className="text-foreground text-base font-medium">{title}</h2>
        <p className="text-muted-foreground mt-1 text-sm text-balance">{description}</p>
      </div>

      {/* `mt-auto` bottom-aligns the row lists. The grid stretches both cards to
          the same height, so without it the shorter card's rows would float in
          the middle of its own box. */}
      <ul className="mt-auto">
        {rows.map((row) => (
          <li key={row.id} className="flex items-center gap-3 border-t px-5 py-3">
            <row.Mark className="text-foreground size-5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-foreground truncate text-sm font-medium">{row.label}</p>
              {row.meta ? (
                <p className="text-muted-foreground truncate text-xs">{row.meta}</p>
              ) : null}
            </div>
            <Button
              asChild
              size="sm"
              variant={row.id === filled ? 'default' : 'outline'}
              className="shrink-0"
            >
              <Link
                href={row.href}
                {...(row.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
              >
                Download
              </Link>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 2: Lint it**

```bash
cd apps/web && npx eslint src/features/marketing/download/platform-card.tsx
```

Expected: clean.

---

### Task 4: The terminal block

**Files:**
- Create: `apps/web/src/features/marketing/download/terminal-block.tsx`
- Delete: `apps/web/src/features/marketing/download/terminal-card.tsx`

**Interfaces:**
- Consumes: `TERMINAL` (Task 2).
- Produces: `TerminalBlock()`. Task 5 renders it once.

- [ ] **Step 1: Write the block**

Full width, so the command has room and does not truncate on a laptop. Same
client-island reasoning as the file it replaces.

```tsx
'use client';

import { CopyButton } from '@/components/markdown/copy-button';
import { getEnv } from '@/lib/env-config';
import { useDeploymentCliInstallCommand } from '@/lib/use-deployment-cli-install-command';
import { TerminalIcon } from '@phosphor-icons/react';

import { TERMINAL } from './content';

/**
 * The CLI install command for THIS deployment (kortix.com, dev, or a preview).
 *
 * Client-only because the origin is a browser fact: the hook reads
 * `window.location.origin` through `useSyncExternalStore`. It renders the
 * origin-less default on the server and settles after hydration. This is the
 * page's ONLY client island — both cards stay server-rendered.
 *
 * `CopyButton` is reused as-is; it already implements the mandated blur + scale
 * + opacity icon crossfade. Do not hand-roll a second `copied` state.
 *
 * Phosphor is imported from the client entry here, not `@/lib/icons/ssr`,
 * because this file is in the client graph.
 */
export function TerminalBlock() {
  const command = useDeploymentCliInstallCommand(getEnv().VERSION);

  return (
    <section className="bg-popover overflow-hidden rounded-md border">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 pt-5 pb-4">
        <TerminalIcon className="text-foreground size-5 shrink-0" />
        <h2 className="text-foreground text-base font-medium">{TERMINAL.title}</h2>
        <p className="text-muted-foreground w-full text-sm sm:w-auto sm:flex-1">
          {TERMINAL.description}
        </p>
        <span className="text-muted-foreground text-xs">{TERMINAL.support}</span>
      </div>

      <div className="bg-muted/50 flex items-center gap-2 border-t px-5 py-3">
        <code className="text-foreground min-w-0 flex-1 truncate font-mono text-xs">
          {command}
        </code>
        <CopyButton code={command} className="shrink-0" />
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Delete the old file and lint**

```bash
cd apps/web && rm src/features/marketing/download/terminal-card.tsx \
  && npx eslint src/features/marketing/download/terminal-block.tsx
```

Expected: clean.

---

### Task 5: Compose the page and delete the dead surfaces

**Files:**
- Create: `apps/web/src/features/marketing/download/card-images.tsx`
- Modify: `apps/web/src/app/(public)/(marketing)/download/page.tsx`
- Modify: `apps/web/src/lib/icons/ssr.tsx`
- Delete: `desktop-hero.tsx`, `surface-cards.tsx`, `all-downloads.tsx`
- Modify: `apps/web/src/components/brand/brand-logos.tsx` (drop `ChromeMark` if
  it has no other consumer)

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: the rendered route. Nothing imports from it.

- [ ] **Step 1: Write the card images**

```tsx
import { cn } from '@/lib/utils';

/**
 * Both card images already ship in `public/`. Nothing here is captured or
 * generated.
 *
 * The desktop pair is toggled with `dark:hidden` / `hidden dark:block`, NOT
 * `<picture media="(prefers-color-scheme: dark)">`. A `media` attribute resolves
 * once at load: correct on first paint, then permanently wrong the moment the
 * visitor uses the app's own theme toggle. Class toggling costs both files
 * (~192 KB) and follows the toggle forever — and needs no hook, which is what
 * keeps this page a Server Component.
 *
 * `alt=""` on every image: each sits directly under its card's own heading, so
 * announcing it again is duplication, not information.
 */

const SHOT = 'block size-full object-cover';

export function DesktopCardImage() {
  return (
    <div className="bg-muted aspect-[16/10] w-full overflow-hidden border-b">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/media/showcase/kortix-showcase-poster.jpg"
        alt=""
        className={cn(SHOT, 'dark:hidden')}
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/media/showcase/kortix-showcase-dark-poster.jpg"
        alt=""
        className={cn(SHOT, 'hidden dark:block')}
      />
    </div>
  );
}

const MOBILE_SHOTS = [
  '/images/mobile-app/app-1.png',
  '/images/mobile-app/app-2.png',
  '/images/mobile-app/app-3.png',
];

/**
 * Three phones in the same 16:10 box the desktop poster occupies, so both cards'
 * headers are the same height and their first row seams line up.
 *
 * The shots are 1080x2337 portrait. Each phone derives its height from its width
 * at that exact ratio, which overflows the box — `items-start` keeps the tops
 * visible and `overflow-hidden` crops the bottoms. That reads as a composed
 * scene rather than a letterboxed screenshot.
 *
 * Borders, never shadows. The `MobileSurface` treatment in `hero-surfaces.tsx`
 * uses `shadow-md`; that part is deliberately not carried over.
 */
export function MobileCardImage() {
  return (
    <div className="bg-muted flex aspect-[16/10] w-full items-start justify-center gap-3 overflow-hidden border-b px-6 pt-8">
      {MOBILE_SHOTS.map((src, i) => (
        <div
          key={src}
          className={cn(
            'border-border bg-background aspect-[1080/2337] min-w-0 flex-1 overflow-hidden rounded-lg border',
            i === 1 ? '-translate-y-2' : 'translate-y-2',
          )}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt="" className="block size-full object-cover object-top" />
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Add `GooglePlayLogoIcon` to the SSR icon barrel**

`AppleLogoIcon` was already added to `apps/web/src/lib/icons/ssr.tsx` earlier on
this branch. `GooglePlayLogoIcon` is not there. Add its two lines — the aliased
import and the weight-bound re-export — following the existing pattern in that
file exactly. Do not import `@phosphor-icons/react` in a server component and do
not pass a `weight` prop.

- [ ] **Step 3: Rewrite the page**

```tsx
import { AppleMark, LinuxMark, WindowsMark } from '@/components/brand/brand-logos';
import { DesktopCardImage, MobileCardImage } from '@/features/marketing/download/card-images';
import {
  DESKTOP_CARD, DESKTOP_ROWS, hero, MOBILE_CARD, MOBILE_ROWS,
} from '@/features/marketing/download/content';
import type { DesktopOs, MobileOs, Platform } from '@/features/marketing/download/detect-os';
import {
  detectPlatform, isMobilePlatform, normalizePlatform, orderedDesktop, orderedMobile,
} from '@/features/marketing/download/detect-os';
import type { CardRow } from '@/features/marketing/download/platform-card';
import { PlatformCard } from '@/features/marketing/download/platform-card';
import {
  formatSize, getLatestRelease, pickDesktopAsset,
} from '@/features/marketing/download/releases';
import { TerminalBlock } from '@/features/marketing/download/terminal-block';
import { AppleLogoIcon, GooglePlayLogoIcon } from '@/lib/icons/ssr';
import type { Metadata } from 'next';
import { headers } from 'next/headers';

export const metadata: Metadata = {
  title: 'Download Kortix',
  description: 'Get Kortix for macOS, Windows, Linux, iOS, and Android.',
};

const DESKTOP_MARKS: Record<DesktopOs, CardRow['Mark']> = {
  macos: AppleMark,
  windows: WindowsMark,
  linux: LinuxMark,
};

const MOBILE_MARKS: Record<MobileOs, CardRow['Mark']> = {
  ios: AppleLogoIcon,
  android: GooglePlayLogoIcon,
};

/**
 * Public download page.
 *
 * A Server Component on purpose: it reads the request user-agent and paints the
 * correct card order and the correct filled button immediately. Reading
 * `headers()` opts the route into dynamic rendering, which it needs anyway for
 * live release data.
 *
 * `?platform=` is honoured so links written against the old query-string
 * redirector still land on the right selection instead of silently defaulting.
 */
export default async function DownloadPage({
  searchParams,
}: {
  searchParams: Promise<{ platform?: string }>;
}) {
  const [headerList, params, release] = await Promise.all([
    headers(),
    searchParams,
    getLatestRelease(),
  ]);

  const detected: Platform =
    normalizePlatform(params.platform) ?? detectPlatform(headerList.get('user-agent'));

  const desktopRows: CardRow[] = orderedDesktop(detected).map((os) => {
    const size = release ? formatSize(pickDesktopAsset(release.assets, os)?.size ?? 0) : '';
    return {
      id: os,
      label: DESKTOP_ROWS[os].label,
      meta: [DESKTOP_ROWS[os].hint, size].filter(Boolean).join(' · '),
      href: DESKTOP_ROWS[os].href,
      Mark: DESKTOP_MARKS[os],
    };
  });

  const mobileRows: CardRow[] = orderedMobile(detected).map((os) => ({
    id: os,
    label: MOBILE_ROWS[os].label,
    meta: MOBILE_ROWS[os].hint,
    href: MOBILE_ROWS[os].href,
    external: true,
    Mark: MOBILE_MARKS[os],
  }));

  const onPhone = isMobilePlatform(detected);

  const desktopCard = (
    <PlatformCard
      key="desktop"
      image={<DesktopCardImage />}
      title={DESKTOP_CARD.title}
      description={DESKTOP_CARD.description}
      rows={desktopRows}
      filled={onPhone ? null : detected}
    />
  );

  const mobileCard = (
    <PlatformCard
      key="mobile"
      image={<MobileCardImage />}
      title={MOBILE_CARD.title}
      description={MOBILE_CARD.description}
      rows={mobileRows}
      filled={onPhone ? detected : null}
    />
  );

  return (
    <main className="mx-auto w-full max-w-5xl px-6 pt-32 pb-24 sm:pt-40">
      <header className="mb-10 text-center">
        <h1 className="text-foreground text-3xl font-semibold tracking-tight sm:text-4xl">
          {hero.title}
        </h1>
        <p className="text-muted-foreground mx-auto mt-3 max-w-md text-balance">{hero.sub}</p>
      </header>

      <div className="space-y-4">
        {/* A phone visitor gets the Mobile card first. `filled` is non-null on
            exactly one card, so exactly one solid button renders in all five
            detection cases. */}
        <div className="grid gap-4 md:grid-cols-2">
          {onPhone ? [mobileCard, desktopCard] : [desktopCard, mobileCard]}
        </div>
        <TerminalBlock />
      </div>
    </main>
  );
}
```

- [ ] **Step 4: Delete the dead surfaces**

```bash
cd apps/web && rm src/features/marketing/download/desktop-hero.tsx \
  src/features/marketing/download/surface-cards.tsx \
  src/features/marketing/download/all-downloads.tsx
```

- [ ] **Step 5: Drop `ChromeMark` if it is now orphaned**

```bash
cd apps/web && grep -rn "ChromeMark" src/ || echo "orphaned"
```

If the only remaining hit is its own definition in `brand-logos.tsx`, delete the
function. If any other file imports it, leave it in place and say so in the
report.

- [ ] **Step 6: Lint and typecheck the changed files**

```bash
cd apps/web && npx eslint src/features/marketing/download 'src/app/(public)/(marketing)/download' src/lib/icons/ssr.tsx
```

Expected: clean.

```bash
cd apps/web && npx tsc --noEmit 2>&1 | grep -E "marketing/download|marketing\)/download|icons/ssr" || echo "no errors in our files"
```

`apps/web` emits ~1500 unrelated `TS2786` errors from the React 19↔18 types
mismatch. Grep for our paths only; do not try to clear the rest.

---

### Task 6: Verify on the real surface

**Files:**
- Create: `scripts/verify-download-ua.ts` (throwaway verifier, deleted in Step 7)

**Interfaces:** consumes the running app on `localhost:14300`.

- [ ] **Step 1: Confirm the stack is up**

```bash
curl -s -o /dev/null -w "%{http_code}\n" localhost:14300/download
```

Expected: `200`. Next.js compiles a cold route on first hit — allow 60s and
retry once before treating a timeout as a failure.

- [ ] **Step 2: Prove the redirectors resolve to real assets**

```bash
for p in macos windows linux; do
  printf "%-8s " "$p"
  curl -sI "localhost:14300/download/$p" | grep -i '^location:'
done
```

Expected: three `302`s whose `location` ends in `Kortix-<v>-universal.dmg`,
`Kortix-Setup-<v>.exe`, and `Kortix-<v>-x86_64.AppImage` respectively.

- [ ] **Step 3: Prove a mobile segment no longer reaches the desktop resolver**

```bash
curl -sI localhost:14300/download/ios | grep -i '^location:'
```

Expected: the GitHub releases page, not a `.dmg`.

- [ ] **Step 4: Prove server-side ordering for all five platforms**

Write `scripts/verify-download-ua.ts`. For each of the five UA strings in
`detect-os.test.ts`, fetch `localhost:14300/download` and assert against the raw
HTML — not a hydrated DOM, because the point is to prove the first byte is right:

1. `Mobile app` appears before `Desktop app` for the `iphone` and `android` UAs,
   and after it for `mac`, `windows` and `linux`.
2. The solid-button class string (`bg-foreground` + `text-background`, as emitted
   by `marketingButtonVariants({ variant: 'default' })`) occurs **exactly once**.
3. That single occurrence is inside the `<li>` whose label matches the expected
   row: `macOS`, `Windows`, `Linux`, `iPhone and iPad`, `Android`.

Print a five-row table and `process.exit(1)` on any mismatch. Read the rendered
HTML once first to pin the exact emitted class string before writing assertion 2.

```bash
cd /Users/jay/root/kortix/suna-download && bun run scripts/verify-download-ua.ts
```

Expected: five PASS rows, exit 0.

- [ ] **Step 5: Assert zero shadows in the browser**

Drive `localhost:14300/download` and evaluate:

```js
[...document.querySelectorAll('main *')]
  .map((el) => [el.tagName + '.' + el.className, getComputedStyle(el).boxShadow])
  .filter(([, s]) => s && s !== 'none');
```

Expected: `[]`.

- [ ] **Step 6: Screenshot the matrix**

Capture four shots: light and dark, at 1280px and 390px width. Confirm by eye:
exactly one filled button, row seams aligned across both cards, phone tops not
clipped, and no horizontal scroll at 390px.

- [ ] **Step 7: Run the full suite and clean up**

```bash
cd apps/web && bun test src/features/marketing/download 'src/app/(utility)/download' \
  src/lib/deployment-cli-install-surfaces.test.ts
```

Expected: all pass. Then delete `scripts/verify-download-ua.ts` — it is evidence,
not shipped code.

---

## Self-Review

**Spec coverage.** D1 → existing routes, kept; Task 1 Step 5 constrains them and
Task 6 Steps 2–3 prove them. D2 → Task 1, proven by Task 6 Step 4. D3 →
`releases.ts`, untouched. D4 → Task 5 Step 3, the `filter(Boolean).join(' · ')`
meta assembly. D5 → already done on this branch; Task 6 Step 7 re-runs its test.
D6 → global constraint, proven by Task 6 Step 5. D7 → Task 5 Step 1. Chrome
removal → Task 5 Steps 4–5. Matrix removal → Task 2 Step 1 and Task 5 Step 4.
Layout → Tasks 3 and 5.

**Placeholder scan.** One deliberate exception: Task 6 Step 4 specifies a
verifier by its three assertions rather than pasting its source, because
assertion 2 depends on the exact class string Tailwind emits, which is only
knowable after Task 5 runs. The step says to read the HTML first and pin it. Task
1 Step 5 likewise gives the condition but tells the implementer to match the
route file's existing redirect idiom rather than paste a possibly-wrong
`NextResponse` call. Everything else is literal.

**Type consistency.** `Platform` is the type of `filled` and of `CardRow['id']`
everywhere. `orderedDesktop` returns `DesktopOs[]` and indexes `DESKTOP_ROWS` and
`DESKTOP_MARKS`, both `Record<DesktopOs, …>`; `orderedMobile` returns `MobileOs[]`
against the mobile equivalents. `CardRow['Mark']` is the single name used for the
icon component type in both `platform-card.tsx` and `page.tsx`. `RowCopy` fields
are `label`/`hint`/`href` in `content.ts` and are mapped to `label`/`meta`/`href`
in the page — the rename is intentional (`hint` is copy, `meta` is copy plus the
live size) and happens in exactly one place.
