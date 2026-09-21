/**
 * dock-icons — icon lookup for `ProjectMoreSheet` and `PageContextMenuSheet`
 * (the project dock itself, and the chat-actions sheet that used to share
 * this module, were both removed — neither had a surviving opener).
 *
 * Typed as a total Record, so adding a DockIconKey without an icon fails
 * typecheck rather than rendering nothing.
 */
import {
  RobotIcon as Bot,
  FolderOpenIcon as FolderOpen,
  GitBranchIcon as GitBranch,
  GitPullRequestIcon as GitPullRequest,
  KeyIcon as Key,
  LinkSimpleIcon as Link2,
  ChatIcon as MessageSquare,
  PencilIcon as Pencil,
  PuzzlePieceIcon as Puzzle,
  GearSixIcon as Settings,
  SparkleIcon as Sparkles,
  TerminalIcon as Terminal,
  TrashIcon as Trash2,
  UsersIcon as Users,
  PackageIcon as Box,
  ClockIcon as Clock,
  CodeIcon as Code,
  type AppIcon,
} from '@/lib/icons';
import type { DockIconKey } from '@/lib/session/dock-menu';

export const DOCK_ICONS: Record<DockIconKey, AppIcon> = {
  // dock rows still used elsewhere (PageContextMenuSheet)
  files: FolderOpen,
  agents: Bot,
  skills: Sparkles,
  settings: Settings,
  rename: Pencil,
  delete: Trash2,
  // more sheet
  commands: Code,
  connectors: Puzzle,
  secrets: Key,
  channels: MessageSquare,
  schedules: Clock,
  webhooks: Link2,
  terminal: Terminal,
  sandbox: Box,
  dev: GitBranch,
  changes: GitPullRequest,
  members: Users,
};
