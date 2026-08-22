/**
 * dock-icons — the only place the pure dock-menu manifest meets React.
 *
 * Typed as a total Record, so adding a DockIconKey without an icon fails
 * typecheck rather than rendering nothing.
 */
import {
  Archive, Bot, ChevronsUpDown, Compass, Download, FolderOpen, GitBranch,
  GitCompare, GitPullRequest, Key, Layers, Link2, MessageSquare, MoreHorizontal,
  Pencil, Puzzle, RefreshCw, Settings, Share2, Sparkles, Terminal,
  Trash2, Users, Brain, Box, Clock, Code,
  type LucideIcon,
} from 'lucide-react-native';
import type { DockIconKey } from '@/lib/session/dock-menu';

export const DOCK_ICONS: Record<DockIconKey, LucideIcon> = {
  // dock rows
  files: FolderOpen,
  browser: Compass,
  agents: Bot,
  skills: Sparkles,
  memory: Brain,
  settings: Settings,
  more: MoreHorizontal,
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
  // chat actions
  rename: Pencil,
  share: Share2,
  restart: RefreshCw,
  export: Download,
  compact: Layers,
  changeRequest: GitPullRequest,
  viewChanges: GitCompare,
  archive: Archive,
  delete: Trash2,
};

/** The pill's trailing affordance. Exported so ProjectDock doesn't re-import lucide. */
export const DOCK_CHEVRON = ChevronsUpDown;
