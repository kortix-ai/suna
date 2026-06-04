/**
 * Tool icon resolver for mobile (lucide-react-native)
 * Uses shared icon keys but resolves to actual React Native components
 */

import { getToolIconKey } from '@agentpress/shared';
import type { ToolIconKey } from '@agentpress/shared';
import {
  Globe,
  FileEdit,
  FileSearch,
  FilePlus,
  FileText,
  FileX,
  List,
  ListTodo,
  Terminal,
  Computer,
  Search,
  ExternalLink,
  Network,
  Table2,
  Code,
  Phone,
  PhoneOff,
  MessageCircleQuestion,
  CheckCircle2,
  Wrench,
  BookOpen,
  Plug,
  Clock,
  Presentation,
  ImageIcon,
  Pencil,
  HammerIcon,
  type LucideIcon,
} from 'lucide-react-native';

/**
 * Map icon keys to lucide-react-native components
 */
const ICON_MAP: Record<ToolIconKey, LucideIcon> = {
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
export function getToolIcon(toolName: string): LucideIcon {
  const key = getToolIconKey(toolName);
  return ICON_MAP[key] ?? Wrench;
}

// Re-export the icon key function for type checking
export { getToolIconKey, type ToolIconKey };

