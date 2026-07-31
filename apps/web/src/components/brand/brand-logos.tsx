/**
 * Official brand logos — Apple / Windows / Linux / Google Play, from Phosphor,
 * rendered in `currentColor` so they adapt to light and dark.
 *
 * All four marks the /download page needs live here, so its five rows draw from
 * one source rather than mixing a local wrapper with a raw icon import. Apple
 * covers two rows: macOS on the desktop card, iPhone and iPad on the mobile one.
 *
 * Icons come from `@/lib/icons/ssr`, not `@phosphor-icons/react`, so this
 * module works in BOTH server and client trees. The main Phosphor entry calls
 * createContext at module scope, which crashes any server component that
 * reaches it — and these marks are used on the public /download page, which is
 * server-rendered. The explicit weight="fill" below still wins over the bound
 * default: logo glyphs stay solid regardless of DEFAULT_ICON_WEIGHT.
 */

import {
  AppleLogoIcon,
  GooglePlayLogoIcon,
  LinuxLogoIcon,
  WindowsLogoIcon,
} from '@/lib/icons/ssr';

type MarkProps = { className?: string };

export function AppleMark({ className }: MarkProps) {
  return <AppleLogoIcon weight="fill" className={className} />;
}

export function WindowsMark({ className }: MarkProps) {
  return <WindowsLogoIcon weight="fill" className={className} />;
}

export function LinuxMark({ className }: MarkProps) {
  return <LinuxLogoIcon weight="fill" className={className} />;
}

export function PlayStoreMark({ className }: MarkProps) {
  return <GooglePlayLogoIcon weight="fill" className={className} />;
}
