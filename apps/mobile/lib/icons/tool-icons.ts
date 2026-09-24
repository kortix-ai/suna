/**
 * Tool icon resolver for mobile (`@/lib/icons`)
 * Uses shared icon keys but resolves to actual React Native components
 */

import { getToolIconKey } from '@kortix/shared';
import type { ToolIconKey } from '@kortix/shared';
import {
  GlobeIcon as Globe,
  NotePencilIcon as FileEdit,
  FileMagnifyingGlassIcon as FileSearch,
  FilePlusIcon as FilePlus,
  FileTextIcon as FileText,
  FileXIcon as FileX,
  ListIcon as List,
  ListChecksIcon as ListTodo,
  TerminalIcon as Terminal,
  DesktopIcon as Computer,
  MagnifyingGlassIcon as Search,
  ArrowSquareOutIcon as ExternalLink,
  NetworkIcon as Network,
  TableIcon as Table2,
  CodeIcon as Code,
  PhoneIcon as Phone,
  PhoneSlashIcon as PhoneOff,
  ChatCircleDotsIcon as MessageCircleQuestion,
  CheckCircleIcon as CheckCircle2,
  WrenchIcon as Wrench,
  BookOpenIcon as BookOpen,
  PlugIcon as Plug,
  ClockIcon as Clock,
  PresentationIcon as Presentation,
  ImageIcon,
  PencilIcon as Pencil,
  HammerIcon,
  type AppIcon,
} from '@/lib/icons';

/**
 * Map icon keys to app icon components
 */
const ICON_MAP: Record<ToolIconKey, AppIcon> = {
  'globe': Globe,
  'file-edit': FileEdit,
  'file-search': FileSearch,
  'file-plus': FilePlus,
  'file-text': FileText,
  'file-x': FileX,
  'list': List,
  'list-todo': ListTodo,
  'terminal': Terminal,
  'computer': Computer,
  'search': Search,
  'external-link': ExternalLink,
  'network': Network,
  'table': Table2,
  'code': Code,
  'phone': Phone,
  'phone-off': PhoneOff,
  'message-question': MessageCircleQuestion,
  'check-circle': CheckCircle2,
  'wrench': Wrench,
  'book-open': BookOpen,
  'plug': Plug,
  'clock': Clock,
  'presentation': Presentation,
  'image': ImageIcon,
  'pencil': Pencil,
  'hammer': HammerIcon,
};

/**
 * Get the icon component for a tool name
 * 
 * @param toolName - The tool name
 * @returns The React Native component for the icon
 */
export function getToolIcon(toolName: string): AppIcon {
  const key = getToolIconKey(toolName);
  return ICON_MAP[key] ?? Wrench;
}

// Re-export the icon key function for type checking
export { getToolIconKey, type ToolIconKey };
