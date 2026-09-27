import {
  TerminalIcon as Terminal,
  PencilSimpleIcon,
  MagnifyingGlassIcon as Search,
  GlobeIcon as Globe,
  ReadCvLogoIcon,
  CheckSquareIcon as CheckSquare,
  CpuIcon as Cpu,
  KanbanIcon as SquareKanban,
  ImageIcon,
  PresentationIcon as Presentation,
  ListIcon as List,
  ScissorsIcon as Scissors,
  ChatCircleIcon as MessageCircle,
  FolderIcon as Folder,
  FolderPlusIcon as FolderPlus,
  FilesIcon,
  FolderOpenIcon,
  StackIcon,
  TerminalWindowIcon,
  UsersThreeIcon,
  FileArchiveIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileImageIcon,
  FileTextIcon,
  FileVideoIcon,
  FileXlsIcon,
  type AppIcon,
} from '@/lib/icons';
import type { ActivityIconKey, FileCategory } from '@/lib/session/activity';

// ─── Tool icon resolver ──────────────────────────────────────────────────────

/**
 * `getToolInfo(...).icon` key → glyph for a tool row's leading icon. `glasses`
 * (read) and `file-pen` (write/edit) use the glyphs apps/web's read and edit
 * renderers draw (`ReadCvLogo`, `PencilSimple`).
 */
export const TOOL_ICON_MAP: Record<string, AppIcon> = {
  terminal: Terminal,
  'file-pen': PencilSimpleIcon,
  search: Search,
  globe: Globe,
  glasses: ReadCvLogoIcon,
  'check-square': CheckSquare,
  'square-kanban': SquareKanban,
  image: ImageIcon,
  presentation: Presentation,
  list: List,
  scissors: Scissors,
  'message-circle': MessageCircle,
  folder: Folder,
  'folder-plus': FolderPlus,
  cpu: Cpu,
};

export function getToolIconByName(iconName: string): AppIcon {
  return TOOL_ICON_MAP[iconName] ?? Cpu;
}

/** apps/web `turn/activity-step.tsx` `ICONS` — group rows and file-chip rows lead with these. */
export const ACTIVITY_ICONS: Record<ActivityIconKey, AppIcon> = {
  read: ReadCvLogoIcon,
  edit: PencilSimpleIcon,
  shell: TerminalWindowIcon,
  search: Search,
  list: FolderOpenIcon,
  web: Globe,
  delegate: UsersThreeIcon,
  skill: FilesIcon,
  generic: StackIcon,
};

/**
 * The glyph inside a file chip's icon well. apps/web picks a per-extension
 * glyph (`fileIconFor`: FileTs, FileJs, FilePdf, …); mobile maps the file
 * category onto the file glyphs already in the registry.
 */
export const FILE_CATEGORY_ICONS: Record<FileCategory, AppIcon> = {
  image: FileImageIcon,
  code: FileCodeIcon,
  text: FileTextIcon,
  markdown: FileTextIcon,
  pdf: FileTextIcon,
  audio: FileAudioIcon,
  video: FileVideoIcon,
  csv: FileXlsIcon,
  spreadsheet: FileXlsIcon,
  archive: FileArchiveIcon,
  database: FileTextIcon,
  other: FileTextIcon,
};
