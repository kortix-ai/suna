/**
 * Icon Mapping Utility
 * 
 * Maps backend icon names (strings) to app icons from `@/lib/icons`
 * Provides fallback icons for unmapped names
 */

import {
  RobotIcon as Bot,
  SparkleIcon as Sparkles,
  CodeSimpleIcon as Code2,
  PresentationIcon,
  FileCodeIcon as FileCode2,
  HeadphonesIcon as Headphones,
  BrainIcon as Brain,
  LightbulbIcon as Lightbulb,
  PencilIcon as Pencil,
  GearSixIcon as Settings,
  UserIcon as User,
  LightningIcon as Zap,
  StarIcon as Star,
  HeartIcon as Heart,
  ShieldIcon as Shield,
  TargetIcon as Target,
  ChatIcon as MessageSquare,
  BookOpenIcon as BookOpen,
  CameraIcon as Camera,
  MusicNotesIcon as Music,
  VideoIcon as Video,
  ImageIcon as Image,
  FileTextIcon as FileText,
  FolderIcon as Folder,
  DatabaseIcon as Database,
  GlobeIcon as Globe,
  LockIcon as Lock,
  LockOpenIcon as Unlock,
  CheckCircleIcon as CheckCircle,
  XCircleIcon as XCircle,
  WarningCircleIcon as AlertCircle,
  InfoIcon as Info,
  QuestionIcon as HelpCircle,
  MagnifyingGlassIcon as Search,
  FunnelIcon as Filter,
  SortAscendingIcon as SortAsc,
  DownloadIcon as Download,
  UploadIcon as Upload,
  ExportIcon as Share,
  CopyIcon as Copy,
  PencilSimpleIcon as Edit,
  TrashIcon as Trash2,
  PlusIcon as Plus,
  MinusIcon as Minus,
  XIcon as X,
  CheckIcon as Check,
  CaretDownIcon as ChevronDown,
  CaretUpIcon as ChevronUp,
  CaretLeftIcon as ChevronLeft,
  CaretRightIcon as ChevronRight,
  ArrowLeftIcon as ArrowLeft,
  ArrowRightIcon as ArrowRight,
  ArrowUpIcon as ArrowUp,
  ArrowDownIcon as ArrowDown,
  HouseIcon as Home,
  ListIcon as Menu,
  DotsThreeIcon as MoreHorizontal,
  DotsThreeVerticalIcon as MoreVertical,
  type AppIcon,
} from '@/lib/icons';

/**
 * Icon mapping from backend icon names to app icons
 */
const ICON_MAP: Record<string, AppIcon> = {
  // Core agent types
  'bot': Bot,
  'sparkles': Sparkles,
  'code': Code2,
  'code2': Code2,
  'presentation': PresentationIcon,
  'presentation-icon': PresentationIcon,
  'file-code': FileCode2,
  'file-code2': FileCode2,
  'headphones': Headphones,
  'brain': Brain,
  'lightbulb': Lightbulb,
  'pencil': Pencil,
  
  // Common icons
  'settings': Settings,
  'user': User,
  'zap': Zap,
  'star': Star,
  'heart': Heart,
  'shield': Shield,
  'target': Target,
  'message-square': MessageSquare,
  'book-open': BookOpen,
  'book': BookOpen,
  
  // Media icons
  'camera': Camera,
  'music': Music,
  'video': Video,
  'image': Image,
  'file-text': FileText,
  'file': FileText,
  'folder': Folder,
  
  // Tech icons
  'database': Database,
  'globe': Globe,
  'lock': Lock,
  'unlock': Unlock,
  
  // Status icons
  'check-circle': CheckCircle,
  'check': CheckCircle,
  'x-circle': XCircle,
  'x': XCircle,
  'alert-circle': AlertCircle,
  'info': Info,
  'help-circle': HelpCircle,
  
  // Action icons
  'search': Search,
  'filter': Filter,
  'sort': SortAsc,
  'download': Download,
  'upload': Upload,
  'share': Share,
  'copy': Copy,
  'edit': Edit,
  'trash': Trash2,
  'trash2': Trash2,
  'plus': Plus,
  'minus': Minus,
  
  // Navigation icons
  'chevron-down': ChevronDown,
  'chevron-up': ChevronUp,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'arrow-left': ArrowLeft,
  'arrow-right': ArrowRight,
  'arrow-up': ArrowUp,
  'arrow-down': ArrowDown,
  
  // UI icons
  'home': Home,
  'menu': Menu,
  'more-horizontal': MoreHorizontal,
  'more-vertical': MoreVertical,
};

/**
 * Default fallback icon
 */
const DEFAULT_ICON = Bot;

/**
 * Get the app icon for a backend icon name
 * 
 * @param iconName - Backend icon name (string)
 * @returns Icon component from `@/lib/icons`
 */
export function getIconFromName(iconName: string | null | undefined): AppIcon {
  if (!iconName) {
    return DEFAULT_ICON;
  }
  
  // Normalize the icon name (lowercase, replace spaces with hyphens)
  const normalizedName = iconName.toLowerCase().replace(/\s+/g, '-');
  
  return ICON_MAP[normalizedName] || DEFAULT_ICON;
}

/**
 * Check if an icon name is mapped
 * 
 * @param iconName - Backend icon name
 * @returns true if icon is mapped, false otherwise
 */
export function isIconMapped(iconName: string | null | undefined): boolean {
  if (!iconName) return false;
  const normalizedName = iconName.toLowerCase().replace(/\s+/g, '-');
  return normalizedName in ICON_MAP;
}

/**
 * Get all available icon names
 * 
 * @returns Array of all mapped icon names
 */
export function getAvailableIconNames(): string[] {
  return Object.keys(ICON_MAP);
}
