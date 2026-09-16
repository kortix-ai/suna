/**
 * dock-icons — the only place the pure dock-menu manifest meets React.
 *
 * Typed as a total Record, so adding a DockIconKey without an icon fails
 * typecheck rather than rendering nothing.
 */
import {
  ArchiveIcon as Archive,
  RobotIcon as Bot,
  CaretUpDownIcon as ChevronsUpDown,
  CompassIcon as Compass,
  DownloadIcon as Download,
  FolderOpenIcon as FolderOpen,
  GitBranchIcon as GitBranch,
  GitDiffIcon as GitCompare,
  GitPullRequestIcon as GitPullRequest,
  KeyIcon as Key,
  StackIcon as Layers,
  LinkSimpleIcon as Link2,
  ChatIcon as MessageSquare,
  DotsThreeIcon as MoreHorizontal,
  PencilIcon as Pencil,
  PuzzlePieceIcon as Puzzle,
  ArrowClockwiseIcon as RefreshCw,
  GearSixIcon as Settings,
  ShareNetworkIcon as Share2,
  SparkleIcon as Sparkles,
  TerminalIcon as Terminal,
  TrashIcon as Trash2,
  UsersIcon as Users,
  BrainIcon as Brain,
  PackageIcon as Box,
  ClockIcon as Clock,
  CodeIcon as Code,
  type AppIcon,
} from '@/lib/icons';
import type { DockIconKey } from '@/lib/session/dock-menu';

export const DOCK_ICONS: Record<DockIconKey, AppIcon> = {
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

/** The pill's trailing affordance. Exported so ProjectDock doesn't import the glyph itself. */
export const DOCK_CHEVRON = ChevronsUpDown;
