/**
 * Kortix brand icon layer.
 *
 * All icon imports in feature code should flow through this file instead of
 * importing from `@phosphor-icons/react` directly. Benefits:
 *
 *   1. Single-line icon library swap (phosphor → geist / tabler / iconoir / …)
 *   2. Stable Kortix-semantic names (`IconInProgress` not `RadioButtonIcon`)
 *   3. Enforces a small curated set — pages can't drift into 40 random icons
 *
 * The app-wide icon weight lives in `src/lib/icons/icon-config.ts` and is
 * applied by IconProvider; individual usages may still pass an explicit
 * weight (status/solid icons use weight="fill").
 *
 * Rule for new pages: if the icon you want isn't exported here, add it here
 * and give it a purposeful name.
 *
 * This file re-exports the client entry; server components (RSC) must
 * import from `@/lib/icons/ssr` instead, which carries the same app-wide
 * weight. Never pass a weight prop in either case.
 */

export {
  // ── CRUD & actions ──────────────────────────────────────────
  PlusIcon as IconAdd,
  CpuIcon as IconAgent,
  WarningCircleIcon as IconAlert,
  ArrowUpRightIcon as IconArrowUpRight,
  // ── Navigation & layout ─────────────────────────────────────
  ArrowLeftIcon as IconBack,
  // ── Status / lifecycle ──────────────────────────────────────
  CircleDashedIcon as IconBacklog,
  RobotIcon as IconBot,
  CalendarIcon as IconCalendar,
  XCircleIcon as IconCancelled,
  CheckIcon as IconCheck,
  CaretDownIcon as IconChevronDown,
  CaretLeftIcon as IconChevronLeft,
  CaretRightIcon as IconChevronRight,
  CaretUpIcon as IconChevronUp,
  CaretUpDownIcon as IconChevronsUpDown,
  // ── Time & data ─────────────────────────────────────────────
  ClockIcon as IconClock,
  XIcon as IconClose,
  CodeSimpleIcon as IconCode,
  ChatCircleIcon as IconComment,
  CopyIcon as IconCopy,
  TrashIcon as IconDelete,
  CheckCircleIcon as IconDone,
  DownloadIcon as IconDownload,
  PencilIcon as IconEdit,
  ArrowSquareOutIcon as IconExternal,
  WarningOctagonIcon as IconFailed,
  FileIcon as IconFile,
  FileTextIcon as IconFileText,
  FunnelIcon as IconFilter,
  FolderIcon as IconFolder,
  FolderOpenIcon as IconFolderOpen,
  ArrowRightIcon as IconForward,
  SquaresFourIcon as IconGrid,
  HashIcon as IconHash,
  RadioButtonIcon as IconInProgress,
  CircleDashedIcon as IconInReview,
  TrayIcon as IconInbox,
  InfoIcon as IconInfo,
  QuestionIcon as IconInfoNeeded,
  UserPlusIcon as IconInvite,
  LinkSimpleIcon as IconLink,
  ListIcon as IconList,
  CircleNotchIcon as IconLoader,
  EnvelopeIcon as IconMail,
  ListIcon as IconMenu,
  ChatIcon as IconMessage,
  DotsThreeIcon as IconMore,
  DotsThreeVerticalIcon as IconMoreVertical,
  BellIcon as IconNotification,
  PauseIcon as IconPause,
  PlayIcon as IconPlay,
  // ── Files & folders ─────────────────────────────────────────
  GitBranchIcon as IconProject,
  ArrowClockwiseIcon as IconRefresh,
  MinusIcon as IconRemove,
  MagnifyingGlassIcon as IconSearch,
  PaperPlaneTiltIcon as IconSend,
  GearSixIcon as IconSettings,
  ArrowsDownUpIcon as IconSort,
  StarIcon as IconStar,
  SquareIcon as IconStop,
  TagIcon as IconTag,
  TerminalIcon as IconTerminal,
  CircleIcon as IconTodo,
  LightningIcon as IconTrigger,
  // phosphor has no star-slash glyph; IconUnstar (currently unused) reuses Star
  StarIcon as IconUnstar,
  UploadIcon as IconUpload,
  // ── People & comms ──────────────────────────────────────────
  UserIcon as IconUser,
  UsersIcon as IconUsers,
  WarningIcon as IconWarning,

  AppWindowIcon as IconApp,
  RocketIcon as IconDeploy,
} from '@phosphor-icons/react';

export type { Icon } from '@phosphor-icons/react';
