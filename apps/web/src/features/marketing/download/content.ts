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
