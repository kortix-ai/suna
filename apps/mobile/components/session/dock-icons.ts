/**
 * dock-icons — icon lookup for `SettingsNavPage`'s Customize group and
 * `PageContextMenuSheet` (`CustomizeSheet`, the icon lookup's other consumer,
 * is deleted — COR-123/COR-160 Task 3).
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
  ClockIcon as Clock,
  type AppIcon,
} from '@/lib/icons';
import type { DockIconKey } from '@/lib/session/dock-menu';

export const DOCK_ICONS: Record<DockIconKey, AppIcon> = {
  // page context menu rows (PageContextMenuSheet)
  files: FolderOpen,
  settings: Settings,
  rename: Pencil,
  delete: Trash2,
  // Workspace "···" prompts (PageContextMenuSheet)
  agents: Bot,
  skills: Sparkles,
  terminal: Terminal,
  // project Settings page, Customize group
  schedules: Clock,
  secrets: Key,
};
