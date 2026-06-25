/**
 * Canonical lucide-react / react-icons -> @mynaui/icons-react name mapping.
 *
 * Single source of truth shared by:
 *  - the codemod (`scripts/migrate-icons-to-mynaui.ts`)
 *  - the runtime dynamic-icon resolver (`@/components/ui/dynamic-icon`)
 *  - `@/lib/utils/icon-utils`
 *
 * Values are mynaui *base* names (no `Solid` suffix). The consumer decides
 * whether to use the `Solid` variant (preferred) or fall back to the outline
 * variant. Entries only exist where the mynaui base name differs from the
 * original name; identity matches (e.g. lucide `Calendar` -> mynaui `Calendar`)
 * are resolved algorithmically and intentionally omitted.
 *
 * Keep this file dependency-free so it can be imported from a Bun script.
 */

/** lucide-react export name -> mynaui base name (Solid preferred at use site). */
export const LUCIDE_TO_MYNAUI: Record<string, string> = {
  // --- Normalized (strip `Icon` suffix / trailing digit / Cw·Ccw) ---
  Building2: 'Building',
  CalendarIcon: 'Calendar',
  CalendarX2: 'CalendarX',
  CheckCircle2: 'CheckCircle',
  CheckIcon: 'Check',
  ChevronDownIcon: 'ChevronDown',
  ChevronRightIcon: 'ChevronRight',
  CircleIcon: 'Circle',
  Code2: 'Code',
  Columns2: 'Columns',
  Columns3: 'Columns',
  CopyIcon: 'Copy',
  Edit2: 'Edit',
  Edit3: 'Edit',
  FileIcon: 'File',
  FilePlus2: 'FilePlus',
  FileX2: 'FileX',
  ImageIcon: 'Image',
  Link2: 'Link',
  Maximize2: 'Maximize',
  Minimize2: 'Minimize',
  MousePointer2: 'MousePointer',
  PanelLeftIcon: 'PanelLeft',
  RefreshCcw: 'Refresh',
  RefreshCw: 'Refresh',
  Rows2: 'Rows',
  Rows3: 'Rows',
  SearchIcon: 'Search',
  Share2: 'Share',
  Table2: 'Table',
  Trash2: 'Trash',
  Undo2: 'Undo',
  UserCircle2: 'UserCircle',

  // --- Curated renames (different vocabulary) ---
  AlertCircle: 'DangerCircle',
  AlertOctagon: 'DangerOctagon',
  AlertTriangle: 'DangerTriangle',
  ArchiveRestore: 'Archive',
  ArrowDownToLine: 'ArrowDown',
  ArrowRightLeft: 'ArrowLeftRight',
  ArrowRightToLine: 'ArrowRight',
  AtSign: 'At',
  BarChart3: 'ChartBar',
  BellRing: 'BellOn',
  Blocks: 'Component',
  Bold: 'TypeBold',
  BookOpenText: 'BookOpen',
  Boxes: 'Package',
  Braces: 'Code',
  CalendarClock: 'Calendar',
  CalendarSync: 'Calendar',
  CheckCheck: 'Check',
  CircleAlert: 'DangerCircle',
  CircleDot: 'Record',
  CircleDotDashed: 'CircleDashed',
  ClipboardCheck: 'Clipboard',
  ClipboardCopy: 'Clipboard',
  ClipboardList: 'Clipboard',
  Clock: 'ClockCircle',
  Coins: 'Dollar',
  Computer: 'Monitor',
  Container: 'Package',
  DollarSign: 'Dollar',
  Feather: 'Pen',
  FileArchive: 'File',
  FileAudio: 'File',
  FileBadge: 'File',
  FileBox: 'File',
  FileChartLine: 'File',
  FileCode: 'File',
  FileCode2: 'File',
  FileCog: 'File',
  FileDown: 'File',
  FileEdit: 'File',
  FileImage: 'File',
  FileJson: 'File',
  FileKey: 'File',
  FileLock: 'File',
  FileMusic: 'File',
  FileQuestion: 'File',
  FileSearch: 'File',
  FileSpreadsheet: 'File',
  FileStack: 'File',
  FileSymlink: 'File',
  FileTerminal: 'File',
  FileType: 'FileText',
  FileVideo: 'File',
  FileWarning: 'File',
  Files: 'File',
  FolderCog: 'Folder',
  FolderGit2: 'Folder',
  FolderOpen: 'Folder',
  FolderRoot: 'Folder',
  FolderUp: 'Folder',
  Frown: 'Sad',
  GitCommitHorizontal: 'GitCommit',
  GitCompareArrows: 'GitDiff',
  GitFork: 'GitBranch',
  GitPullRequestArrow: 'GitPullRequest',
  GitPullRequestClosed: 'GitPullRequest',
  GlobeLock: 'Globe',
  Grid2x2: 'Grid',
  Handshake: 'Hand',
  HelpCircle: 'QuestionCircle',
  History: 'Undo',
  Hourglass: 'ClockCircle',
  ImagePlus: 'Image',
  Italic: 'TypeItalic',
  KeyRound: 'Key',
  Languages: 'Globe',
  Layers: 'LayersOne',
  Layers2: 'LayersTwo',
  LayoutDashboard: 'Grid',
  LayoutGrid: 'Grid',
  LayoutList: 'List',
  LayoutTemplate: 'Layout',
  ListOrdered: 'ListNumber',
  ListTodo: 'ListCheck',
  ListTree: 'List',
  Loader2: 'Spinner',
  LogIn: 'Login',
  LogOut: 'Logout',
  MailCheck: 'Mail',
  MessageCircle: 'Chat',
  MessageCircleQuestion: 'Chat',
  MessageSquare: 'Message',
  MessageSquareMore: 'MessageDots',
  MessageSquareQuote: 'Message',
  MessagesSquare: 'ChatMessages',
  Mic: 'Microphone',
  MonitorPlay: 'Monitor',
  MoreHorizontal: 'Dots',
  MoreVertical: 'DotsVertical',
  PackageOpen: 'Package',
  PackageSearch: 'Package',
  Palette: 'Paint',
  PenTool: 'Pen',
  Phone: 'Telephone',
  PhoneOff: 'TelephoneOff',
  PinOff: 'Pin',
  Plug: 'Power',
  PowerOff: 'Power',
  Reply: 'MessageReply',
  RotateCcw: 'Refresh',
  RotateCw: 'Refresh',
  ScrollText: 'FileText',
  Server: 'Servers',
  ServerOff: 'Servers',
  Settings: 'CogOne',
  Settings2: 'CogOne',
  SlidersHorizontal: 'Filter',
  Smartphone: 'Mobile',
  SquarePen: 'Edit',
  SquareTerminal: 'Terminal',
  Tags: 'Tag',
  TerminalSquare: 'Terminal',
  ThumbsDown: 'Dislike',
  ThumbsUp: 'Like',
  Timer: 'ClockCircle',
  TriangleAlert: 'DangerTriangle',
  Type: 'TypeText',
  Underline: 'TypeUnderline',
  Unlock: 'LockOpen',
  Unplug: 'Power',
  UserRound: 'User',
  Volume2: 'VolumeHigh',
  Wand2: 'Sparkles',
  ZoomIn: 'SearchPlus',
  ZoomOut: 'SearchMinus',

  // --- Forced / low-confidence: no close mynaui equivalent (review these) ---
  AppWindow: 'PanelTop',
  Bot: 'Sparkles',
  Brain: 'Sparkles',
  Bug: 'Danger',
  Cable: 'Share',
  Cpu: 'Microchip',
  Fingerprint: 'Key',
  Gauge: 'Activity',
  Hammer: 'Tool',
  LifeBuoy: 'QuestionCircle',
  Lightbulb: 'Sparkles',
  MemoryStick: 'Microchip',
  Network: 'Share',
  Newspaper: 'FileText',
  Quote: 'Chat',
  Receipt: 'FileText',
  Scale: 'Activity',
  ShieldAlert: 'Shield',
  StarOff: 'Star',
  Stethoscope: 'Activity',
  Strikethrough: 'TypeText',
  Wallet: 'CreditCard',
  Webhook: 'Share',
  Workflow: 'Share',
};

/** react-icons export name -> mynaui base name (names are unique across subpackages here). */
export const REACT_ICONS_TO_MYNAUI: Record<string, string> = {
  AiOutlineCheck: 'Check',
  CgClose: 'X',
  FaUsers: 'Users',
  GoCheckCircleFill: 'CheckCircle',
  GoHomeFill: 'Home',
  HiArrowRight: 'ArrowRight',
  HiDotsHorizontal: 'Dots',
  HiOutlineExclamationCircle: 'DangerCircle',
  HiOutlineViewGrid: 'Grid',
  HiOutlineXCircle: 'XCircle',
  HiMiniSparkles: 'Sparkles',
  LuMonitorSmartphone: 'Monitor',
  MdShield: 'Shield',
  PiChatCircleDotsFill: 'ChatDots',
  PiCheckCircleFill: 'CheckCircle',
  PiClockCountdownFill: 'ClockCircle',
  RiCpuLine: 'Microchip',
  RiFolder3Fill: 'Folder',
  RiMicAiFill: 'Microphone',
  SiGithub: 'Github',
  TbTerminal: 'Terminal',

  // --- Forced / low-confidence: no close mynaui equivalent (review these) ---
  FaWindows: 'Monitor',
  HiOutlineSlash: 'ChevronRight',
  PiSmileyMeltingFill: 'Sad',
  RiRobot2Fill: 'Sparkles',
  RiRobot3Fill: 'Sparkles',
};

/**
 * Names whose mapping is a best-effort "closest" choice because mynaui has no
 * real equivalent. The codemod flags every one of these in MIGRATION_REPORT.md
 * for manual review.
 */
export const FORCED_MAPPINGS: ReadonlySet<string> = new Set<string>([
  // lucide
  'AppWindow', 'Bot', 'Brain', 'Bug', 'Cable', 'Cpu', 'Fingerprint', 'Gauge', 'Hammer',
  'LifeBuoy', 'Lightbulb', 'MemoryStick', 'Network', 'Newspaper', 'Quote',
  'Receipt', 'Scale', 'ShieldAlert', 'StarOff', 'Stethoscope', 'Strikethrough',
  'Wallet', 'Webhook', 'Workflow',
  // react-icons
  'FaWindows', 'HiOutlineSlash', 'PiSmileyMeltingFill', 'RiRobot2Fill',
  'RiRobot3Fill',
]);

/**
 * Default variant policy: **regular (outline)**. Icons render in their outline
 * form unless their mynaui *base* name is listed here, in which case the Solid
 * variant is used. Resolvers (codemod + runtime) consult this set to decide
 * whether to append the `Solid` suffix.
 *
 * Keep this list short and intentional — it's the set of icons we deliberately
 * want filled.
 */
export const FORCE_SOLID: ReadonlySet<string> = new Set<string>([
  'CogOne', // Settings — filled gear reads better in nav
  'Users',  // user / group avatars
  'Trash',  // trash / delete actions
]);

/** Convert a PascalCase identifier to kebab-case (e.g. `MessageCircle` -> `message-circle`). */
export function toKebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

/** Convert a kebab-case string to PascalCase (e.g. `message-circle` -> `MessageCircle`). */
export function toPascalCase(name: string): string {
  return name
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

/**
 * Build a kebab->kebab alias map for the dynamic resolver: any lucide icon whose
 * mynaui base name differs maps its kebab name to the mynaui kebab name, so
 * previously-stored lucide icon names (e.g. `"message-circle"`, `"trash-2"`)
 * still resolve under the mynaui vocabulary.
 */
export function buildKebabAliasMap(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [lucide, myna] of Object.entries(LUCIDE_TO_MYNAUI)) {
    out[toKebabCase(lucide)] = toKebabCase(myna);
  }
  return out;
}
