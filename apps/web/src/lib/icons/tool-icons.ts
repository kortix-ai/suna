/**
 * Tool icon resolver for frontend (lucide-react)
 * Uses shared icon keys but resolves to actual React components
 */

import type React from 'react';
import type { ElementType } from 'react';
import { getToolIconKey } from '@kortix/shared';
import type { ToolIconKey } from '@kortix/shared';
import { Globe, File as FileEdit, File as FileSearch, FilePlus, FileText, FileX, List, ListCheck as ListTodo, Terminal, Monitor as Computer, Search, ExternalLink, Share as Network, Table as Table2, Code, Telephone as Phone, TelephoneOff as PhoneOff, Chat as MessageCircleQuestion, CheckCircle as CheckCircle2, Wrench, BookOpen, Power as Plug, ClockCircle as Clock, Presentation, Image as ImageIcon, Pencil, Tool as Hammer } from '@mynaui/icons-react';

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
export function getToolIcon(toolName: string): React.ComponentType<{ className?: string }> {
  const key = getToolIconKey(toolName);
  return (ICON_MAP[key] ?? Wrench) as React.ComponentType<{ className?: string }>;
}

// Re-export the icon key function for type checking
export { getToolIconKey, type ToolIconKey };
