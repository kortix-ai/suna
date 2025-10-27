/**
 * Icon Mapping Utility
 * 
 * Maps backend icon names (strings) to Lucide React Native icons
 * Provides fallback icons for unmapped names
 */

import {
  Bot,
  Sparkles,
  Code2,
  PresentationIcon,
  FileCode2,
  Headphones,
  Brain,
  Lightbulb,
  Pencil,
  Settings,
  User,
  Zap,
  Star,
  Heart,
  Shield,
  Target,
  MessageSquare,
  BookOpen,
  Camera,
  Music,
  Video,
  Image,
  FileText,
  Folder,
  Database,
  Globe,
  Lock,
  Unlock,
  CheckCircle,
  XCircle,
  AlertCircle,
  Info,
  HelpCircle,
  Search,
  Filter,
  SortAsc,
  Download,
  Upload,
  Share,
  Copy,
  Edit,
  Trash2,
  Plus,
  Minus,
  X,
  Check,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowDown,
  Home,
  Menu,
  MoreHorizontal,
  MoreVertical,
  type LucideIcon,
} from 'lucide-react-native';

/**
 * Icon mapping from backend icon names to Lucide icons
 */
const ICON_MAP: Record<string, LucideIcon> = {
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
 * Get Lucide icon from backend icon name
 * 
 * @param iconName - Backend icon name (string)
 * @returns Lucide React Native icon component
 */
export function getIconFromName(iconName: string | null | undefined): LucideIcon {
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
