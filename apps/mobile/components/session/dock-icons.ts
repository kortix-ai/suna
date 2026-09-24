/**
 * dock-icons — icon lookup for `SettingsNavPage`'s Customize group
 * (`PROJECT_CUSTOMIZE_ITEMS`, `lib/session/dock-menu.ts`).
 *
 * Typed as a total Record, so adding a DockIconKey without an icon fails
 * typecheck rather than rendering nothing.
 */
import { ClockIcon as Clock, KeyIcon as Key, type AppIcon } from '@/lib/icons';
import type { DockIconKey } from '@/lib/session/dock-menu';

export const DOCK_ICONS: Record<DockIconKey, AppIcon> = {
  schedules: Clock,
  secrets: Key,
};
