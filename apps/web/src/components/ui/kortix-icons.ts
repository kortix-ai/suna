/**
 * Kortix brand icon layer.
 *
 * All icon imports in feature code should flow through this file instead of
 * importing from `lucide-react` directly. Benefits:
 *
 *   1. Single-line icon library swap (lucide → geist / tabler / iconoir / …)
 *   2. Stable Kortix-semantic names (`IconStatus` not `CircleDot`)
 *   3. Enforces a small curated set — pages can't drift into 40 random icons
 *
 * Rule for new pages: if the icon you want isn't exported here, add it here
 * and give it a purposeful name.
 */

export {
  // ── CRUD & actions ──────────────────────────────────────────
  Plus as IconAdd,
  Cpu as IconAgent,
  AlertCircle as IconAlert,
  ArrowUpRight as IconArrowUpRight,
  // ── Navigation & layout ─────────────────────────────────────
  ArrowLeft as IconBack,
  // ── Status / lifecycle ──────────────────────────────────────
  CircleDashed as IconBacklog,
  Bot as IconBot,
  Calendar as IconCalendar,
  XCircle as IconCancelled,
  Check as IconCheck,
  ChevronDown as IconChevronDown,
  ChevronLeft as IconChevronLeft,
  ChevronRight as IconChevronRight,
  ChevronUp as IconChevronUp,
  ChevronsUpDown as IconChevronsUpDown,
  // ── Time & data ─────────────────────────────────────────────
  Clock as IconClock,
  X as IconClose,
  Code2 as IconCode,
  MessageCircle as IconComment,
  Copy as IconCopy,
  Trash2 as IconDelete,
  CheckCircle2 as IconDone,
  Download as IconDownload,
  Pencil as IconEdit,
  ExternalLink as IconExternal,
  AlertOctagon as IconFailed,
  File as IconFile,
  FileText as IconFileText,
  Filter as IconFilter,
  Folder as IconFolder,
  FolderOpen as IconFolderOpen,
  ArrowRight as IconForward,
  LayoutGrid as IconGrid,
  Hash as IconHash,
  CircleDot as IconInProgress,
  CircleDotDashed as IconInReview,
  Inbox as IconInbox,
  Info as IconInfo,
  HelpCircle as IconInfoNeeded,
  UserPlus as IconInvite,
  Link2 as IconLink,
  List as IconList,
  Loader2 as IconLoader,
  Mail as IconMail,
  Menu as IconMenu,
  MessageSquare as IconMessage,
  MoreHorizontal as IconMore,
  MoreVertical as IconMoreVertical,
  Bell as IconNotification,
  Pause as IconPause,
  Play as IconPlay,
  // ── Files & folders ─────────────────────────────────────────
  FolderGit2 as IconProject,
  RotateCw as IconRefresh,
  Minus as IconRemove,
  Search as IconSearch,
  Send as IconSend,
  Settings as IconSettings,
  ArrowUpDown as IconSort,
  Star as IconStar,
  Square as IconStop,
  Tag as IconTag,
  Terminal as IconTerminal,
  Circle as IconTodo,
  Zap as IconTrigger,
  StarOff as IconUnstar,
  Upload as IconUpload,
  // ── People & comms ──────────────────────────────────────────
  User as IconUser,
  Users as IconUsers,
  AlertTriangle as IconWarning,

  AppWindow as IconApp,
  Rocket as IconDeploy,
} from 'lucide-react';


export type { LucideIcon as Icon } from 'lucide-react';
