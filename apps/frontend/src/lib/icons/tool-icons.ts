/**
 * Tool icon resolver for frontend (lucide-react)
 * Uses shared icon keys but resolves to actual React components
 */

import type { ElementType } from 'react';
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
  Hammer,
} from 'lucide-react';

/**
 * Map icon keys to lucide-react components
 */
const ICON_MAP: Record<ToolIconKey, ElementType> = {
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
  'hammer': Hammer,
};

/**
 * Get the icon component for a tool name
 * 
 * @param toolName - The tool name
 * @returns The React component for the icon
 */
export function getToolIcon(toolName: string): ElementType {
  const key = getToolIconKey(toolName);
  return ICON_MAP[key] ?? Wrench;
}

// Re-export the icon key function for type checking
export { getToolIconKey, type ToolIconKey };

