/**
 * Official brand logos.
 *  - Apple / macOS / Linux → @icons-pack/react-simple-icons (official Simple
 *    Icons), rendered in `currentColor` so they adapt to light/dark.
 *  - Windows → react-icons Font Awesome (Simple Icons dropped the Windows mark).
 *  - Chrome → the official multicolor logo from /public/brand/chrome.svg
 *    (Simple Icons only ships a flat single-color Chrome mark).
 *
 * App Store / Google Play use the official store badges in /public/stores
 * directly (they include the wordmark), so they're not wrapped here.
 */

import { SiApple, SiLinux } from '@icons-pack/react-simple-icons';
import { FaWindows } from 'react-icons/fa6';

type MarkProps = { className?: string };

export function AppleMark({ className }: MarkProps) {
  return <SiApple className={className} />;
}

export function WindowsMark({ className }: MarkProps) {
  return <FaWindows className={className} />;
}

export function LinuxMark({ className }: MarkProps) {
  return <SiLinux className={className} />;
}

export function ChromeMark({ className }: MarkProps) {
  // Official multicolor Chrome logo, inlined so it renders without depending on
  // a deployed /public asset (a missing image is the usual "nothing renders" in
  // the desktop webview before a deploy). Simple Icons only ships a flat mark.
  return (
    <svg viewBox="0 0 48 48" className={className} role="img" aria-hidden>
      <path fill="#EA4335" d="M24 24 L4.95 13 A22 22 0 0 1 43.05 13 Z" />
      <path fill="#34A853" d="M24 24 L24 46 A22 22 0 0 1 4.95 13 Z" />
      <path fill="#FBBC04" d="M24 24 L43.05 13 A22 22 0 0 1 24 46 Z" />
      <circle cx="24" cy="24" r="10" fill="#fff" />
      <circle cx="24" cy="24" r="8" fill="#1A73E8" />
    </svg>
  );
}
