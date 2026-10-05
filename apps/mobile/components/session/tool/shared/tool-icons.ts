import {
  ArrowSquareOutIcon,
  CheckSquareIcon as CheckSquare,
  CodeSimpleIcon,
  CpuIcon as Cpu,
  FileCodeIcon,
  FileCsvIcon,
  FileDocIcon,
  FileHtmlIcon,
  FileIcon,
  FileMdIcon,
  FilePdfIcon,
  FilePptIcon,
  FileSvgIcon,
  FileTextIcon,
  FileXlsIcon,
  FileZipIcon,
  FilesIcon,
  FolderIcon as Folder,
  FolderOpenIcon,
  FolderPlusIcon as FolderPlus,
  GlobeIcon,
  ImageIcon,
  KanbanIcon as SquareKanban,
  ListIcon as List,
  MagnifyingGlassIcon as Search,
  ChatCircleIcon as MessageCircle,
  MusicNotesIcon,
  PencilSimpleIcon,
  PresentationIcon as Presentation,
  ReadCvLogoIcon,
  ScissorsIcon as Scissors,
  StackIcon,
  TerminalIcon as Terminal,
  TerminalWindowIcon,
  TextTIcon,
  UsersThreeIcon,
  VideoIcon,
  WarningIcon,
  type AppIcon,
} from '@/lib/icons';
import type { ActivityIconKey } from '@/lib/session/activity';

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
  globe: GlobeIcon,
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
  web: GlobeIcon,
  delegate: UsersThreeIcon,
  skill: FilesIcon,
  generic: StackIcon,
};

// ─── Show tool icons ─────────────────────────────────────────────────────────

/**
 * The glyph per `show` type and file extension. Web returns a sized node; mobile
 * returns the `AppIcon` so the caller sizes and tints it (`<ToolIconSlot icon={…}
 * size color />`); `showFileTypeIcon` resolves the extension first, then the type.
 */
export function showTypeIcon(type: string): AppIcon {
  switch (type) {
    case 'image':
      return ImageIcon;
    case 'video':
      return VideoIcon;
    case 'audio':
      return MusicNotesIcon;
    case 'code':
      return CodeSimpleIcon;
    case 'markdown':
    case 'text':
      return TextTIcon;
    case 'html':
    case 'url':
      return GlobeIcon;
    case 'pdf':
      return FileTextIcon;
    case 'error':
      return WarningIcon;
    case 'file':
      return FileIcon;
    default:
      return ArrowSquareOutIcon;
  }
}

const SHOW_EXT_ICONS: Array<[RegExp, AppIcon]> = [
  [/\.pdf$/i, FilePdfIcon],
  [/\.(pptx?|key|odp)$/i, FilePptIcon],
  [/\.(docx?|rtf|odt)$/i, FileDocIcon],
  [/\.(xlsx?|ods)$/i, FileXlsIcon],
  [/\.(csv|tsv)$/i, FileCsvIcon],
  [/\.(html?|xhtml)$/i, FileHtmlIcon],
  [/\.(mdx?|markdown)$/i, FileMdIcon],
  [/\.svg$/i, FileSvgIcon],
  [/\.(zip|tar|gz|tgz|rar|7z)$/i, FileZipIcon],
  [/\.(png|jpe?g|gif|webp|avif|heic|bmp|ico)$/i, ImageIcon],
  [/\.(mp4|mov|webm|mkv|avi)$/i, VideoIcon],
  [/\.(mp3|wav|m4a|aac|ogg|flac)$/i, MusicNotesIcon],
  [
    /\.(m?[jt]sx?|py|rb|go|rs|java|cc?|cpp|hpp?|cs|php|sh|bash|zsh|json|ya?ml|toml|sql|s?css|less|vue|swift|kt)$/i,
    FileCodeIcon,
  ],
];

const SHOW_TYPE_FILE_ICONS: Record<string, AppIcon> = {
  pdf: FilePdfIcon,
  ppt: FilePptIcon,
  pptx: FilePptIcon,
  doc: FileDocIcon,
  docx: FileDocIcon,
  xls: FileXlsIcon,
  xlsx: FileXlsIcon,
  csv: FileCsvIcon,
  audio: MusicNotesIcon,
  code: FileCodeIcon,
  markdown: FileMdIcon,
};

export function showFileTypeIcon(type: string, path?: string): AppIcon {
  if (path) {
    for (const [re, ExtIcon] of SHOW_EXT_ICONS) {
      if (re.test(path)) return ExtIcon;
    }
  }
  return SHOW_TYPE_FILE_ICONS[type] ?? showTypeIcon(type);
}
