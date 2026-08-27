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
 *  2. Linux desktop is x86_64 ONLY. There is no arm64 AppImage. The row says so
 *     rather than letting an ARM visitor download a binary that will not run.
 *  3. There is NO Windows CLI binary. The install script is bash-only, so the
 *     terminal block says "macOS & Linux · WSL on Windows".
 *  4. There is no Chrome extension in this repo — no manifest, no app. The page
 *     must not advertise one, not even as "coming soon".
 *  5. NEITHER mobile app is publicly installable. iOS is on TestFlight and
 *     Android is on a Play internal track, so both store URLs are dead ends for
 *     the public. The rows carry a status instead of a link — see MOBILE_ROWS.
 */

import type { DesktopChannel } from '@/lib/desktop-channels';

import type { DesktopOs, MobileOs } from './detect-os';

export const hero = {
  title: 'Download Kortix',
  sub: 'Get the app for your desktop, your phone, or your terminal.',
};

export type CardCopy = { title: string; description: string };
export type RowCopy = { label: string; hint: string; href: string };
/** A platform with no public build yet, so there is nothing to link to. */
export type ComingSoonRowCopy = { label: string; hint: string };

export const DESKTOP_CARD: CardCopy = {
  title: 'Desktop app',
  description: 'Run Kortix on your own machine, with your files and your terminal.',
};

/**
 * Copy overrides for the non-production hosts.
 *
 * dev.kortix.com and staging.kortix.com serve their OWN desktop build, not the
 * released one. The card has to say so plainly: these installers point at a
 * different backend, and a tester who cannot tell which app they just launched
 * is the exact problem this page is solving. `badge` is a mono chip under the
 * hero — the app icons carry the colour, so the page stays neutral.
 *
 * Stable has no entry: kortix.com renders DESKTOP_CARD unchanged, so a customer
 * never sees channel vocabulary they have no use for.
 */
export const DESKTOP_CHANNEL_COPY: Record<
  Exclude<DesktopChannel, 'stable'>,
  CardCopy & { badge: string }
> = {
  dev: {
    badge: 'Dev build',
    title: 'Kortix Dev desktop app',
    description:
      'The dev build, rebuilt from main. It opens dev.kortix.com and installs alongside Kortix and Kortix Staging.',
  },
  staging: {
    badge: 'Staging build',
    title: 'Kortix Staging desktop app',
    description:
      'The release-candidate build. It opens staging.kortix.com and installs alongside Kortix and Kortix Dev.',
  },
};

export const MOBILE_CARD: CardCopy = {
  title: 'Mobile app',
  description: 'Start a session anywhere and pick up where you left off.',
};

/**
 * `hint` is the line under the label, and it carries copy ONLY. The live
 * download size is appended at render from the GitHub release, so when that API
 * is unreachable the size disappears instead of printing a stale or invented
 * number.
 */
export const DESKTOP_ROWS: Record<DesktopOs, RowCopy> = {
  macos: { label: 'macOS', hint: 'Universal', href: '/download/macos' },
  windows: { label: 'Windows', hint: '64-bit', href: '/download/windows' },
  linux: { label: 'Linux', hint: 'AppImage · x86_64', href: '/download/linux' },
};

/** The chip both mobile rows carry in place of a Download button. */
export const MOBILE_STATUS = 'Coming soon';

/**
 * NO `href`. Both store listings exist, but neither is public: iOS ships to
 * TestFlight and Android to a Play internal track. Linking them sends a visitor
 * to a page they cannot install from, which is worse than saying "not yet".
 *
 * `hint` still names the store each build will land in, so the row stays useful
 * as a statement of intent. Restore the links only when both listings are
 * publicly downloadable — and then the type change is the reminder.
 */
export const MOBILE_ROWS: Record<MobileOs, ComingSoonRowCopy> = {
  ios: { label: 'iPhone and iPad', hint: 'App Store' },
  android: { label: 'Android', hint: 'Google Play' },
};

export const TERMINAL = {
  title: 'Terminal',
  description: 'Install the CLI and drive Kortix from your shell.',
  support: 'macOS & Linux · WSL on Windows',
};
