/**
 * dock-icons — icon lookup for `CustomizeSheet` and `PageContextMenuSheet`.
 *
 * Typed as a total Record, so adding a DockIconKey without an icon fails
 * typecheck rather than rendering nothing.
 */
import {
  RobotIcon as Bot,
  FolderOpenIcon as FolderOpen,
  KeyIcon as Key,
  PencilIcon as Pencil,
  GearSixIcon as Settings,
  SparkleIcon as Sparkles,
  TerminalIcon as Terminal,
  TrashIcon as Trash2,
  UsersIcon as Users,
  ClockIcon as Clock,
  SealCheckIcon as SealCheck,
  type AppIcon,
} from '@/lib/icons';
import type { DockIconKey } from '@/lib/session/dock-menu';

export const DOCK_ICONS: Record<DockIconKey, AppIcon> = {
  // page context menu rows (PageContextMenuSheet)
  files: FolderOpen,
  settings: Settings,
  rename: Pencil,
  delete: Trash2,
  // project sheet, core sections
  agents: Bot,
  skills: Sparkles,
  schedules: Clock,
  review: SealCheck,
  secrets: Key,
  // project sheet, more
  members: Users,
  terminal: Terminal,
};
