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
  // ── Navigation & layout ─────────────────────────────────────
  ArrowLeft as IconBack,
  ArrowRight as IconForward,
  ArrowUpRight as IconArrowUpRight,
  ChevronDown as IconChevronDown,
  ChevronRight as IconChevronRight,
  ChevronUp as IconChevronUp,
  ChevronLeft as IconChevronLeft,
  ChevronsUpDown as IconChevronsUpDown,
  X as IconClose,
  Menu as IconMenu,
  MoreHorizontal as IconMore,
  MoreVertical as IconMoreVertical,

  // ── Files & folders ─────────────────────────────────────────
  FolderGit2 as IconProject,
  Folder as IconFolder,
  FolderOpen as IconFolderOpen,
  File as IconFile,
  FileText as IconFileText,
  Code2 as IconCode,
  Terminal as IconTerminal,

  // ── CRUD & actions ──────────────────────────────────────────
  Plus as IconAdd,
  Minus as IconRemove,
  Trash2 as IconDelete,
  Pencil as IconEdit,
  Copy as IconCopy,
  Check as IconCheck,
  Loader2 as IconLoader,
  RotateCw as IconRefresh,
  Download as IconDownload,
  Upload as IconUpload,
  ExternalLink as IconExternal,
  Link2 as IconLink,
  Search as IconSearch,
  Filter as IconFilter,
  ArrowUpDown as IconSort,
  LayoutGrid as IconGrid,
  List as IconList,
  Star as IconStar,
  StarOff as IconUnstar,

  // ── Status / lifecycle ──────────────────────────────────────
  CircleDashed as IconBacklog,
  Circle as IconTodo,
  CircleDot as IconInProgress,
  CircleDotDashed as IconInReview,
  HelpCircle as IconInfoNeeded,
  CheckCircle2 as IconDone,
  XCircle as IconCancelled,
  AlertOctagon as IconFailed,
  AlertTriangle as IconWarning,
  AlertCircle as IconAlert,
  Info as IconInfo,

  // ── People & comms ──────────────────────────────────────────
  User as IconUser,
  Users as IconUsers,
  UserPlus as IconInvite,
  Bot as IconBot,
  MessageSquare as IconMessage,
  MessageCircle as IconComment,
  Bell as IconNotification,
  Send as IconSend,
  Mail as IconMail,

  // ── Time & data ─────────────────────────────────────────────
  Clock as IconClock,
  Calendar as IconCalendar,
  Play as IconPlay,
  Pause as IconPause,
  Square as IconStop,
  Zap as IconTrigger,
  Cpu as IconAgent,
  Settings as IconSettings,
  Tag as IconTag,
  Hash as IconHash,
  Inbox as IconInbox,
} from 'lucide-react';

export type { LucideIcon as Icon } from 'lucide-react';
