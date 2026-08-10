/**
 * Centralized file utilities
 * Consolidated from file-attachment.tsx for reuse across components
 */

import {
  FileArchiveIcon,
  FileAudioIcon,
  FileCIcon,
  FileCodeIcon,
  FileCppIcon,
  FileCSharpIcon,
  FileCssIcon,
  FileCsvIcon,
  FileDocIcon,
  FileHtmlIcon,
  FileImageIcon,
  FileIniIcon,
  FileJpgIcon,
  FileJsIcon,
  FileJsxIcon,
  FileLockIcon,
  FileMdIcon,
  FilePdfIcon,
  FilePngIcon,
  FilePptIcon,
  FilePyIcon,
  FileRsIcon,
  FileSqlIcon,
  FileSvgIcon,
  FileTextIcon,
  FileTsIcon,
  FileTsxIcon,
  FileTxtIcon,
  FileVideoIcon,
  FileVueIcon,
  FileXlsIcon,
  FileZipIcon,
} from '@phosphor-icons/react';

type PhosphorIcon = typeof FileTextIcon;

/**
 * Extension → the glyph Phosphor already draws for it.
 *
 * Every surface that showed a file — the chip on a write row, the tile on a
 * user message, the drive list — drew one of five category glyphs, so a `.pdf`,
 * a `.png` and a `.zip` were all "a file" and every `.ts`, `.css` and `.html`
 * was the same anonymous `FileCode`. Phosphor ships a specific icon for each of
 * these; not using them was throwing away recognition the reader gets for free.
 *
 * Grouped by what the icon actually depicts, not by language family: `.scss`
 * gets the CSS glyph because that is what it compiles to and what it looks like,
 * and `.mjs` gets the JS one for the same reason.
 *
 * Anything not listed falls back to {@link FileTextIcon} — the honest answer for
 * an unknown file, and never a lie about its contents.
 */
const ICON_BY_EXTENSION: Readonly<Record<string, PhosphorIcon>> = {
  // Documents
  pdf: FilePdfIcon,
  doc: FileDocIcon,
  docx: FileDocIcon,
  odt: FileDocIcon,
  rtf: FileDocIcon,
  txt: FileTxtIcon,
  log: FileTxtIcon,
  md: FileMdIcon,
  mdx: FileMdIcon,
  markdown: FileMdIcon,

  // Presentations and sheets
  ppt: FilePptIcon,
  pptx: FilePptIcon,
  key: FilePptIcon,
  xls: FileXlsIcon,
  xlsx: FileXlsIcon,
  ods: FileXlsIcon,
  csv: FileCsvIcon,
  tsv: FileCsvIcon,

  // Web
  html: FileHtmlIcon,
  htm: FileHtmlIcon,
  css: FileCssIcon,
  scss: FileCssIcon,
  sass: FileCssIcon,
  less: FileCssIcon,
  styl: FileCssIcon,

  // JavaScript and TypeScript
  js: FileJsIcon,
  mjs: FileJsIcon,
  cjs: FileJsIcon,
  jsx: FileJsxIcon,
  ts: FileTsIcon,
  mts: FileTsIcon,
  cts: FileTsIcon,
  tsx: FileTsxIcon,
  vue: FileVueIcon,

  // Other languages
  py: FilePyIcon,
  pyi: FilePyIcon,
  pyw: FilePyIcon,
  rs: FileRsIcon,
  c: FileCIcon,
  h: FileCIcon,
  cpp: FileCppIcon,
  cc: FileCppIcon,
  cxx: FileCppIcon,
  hpp: FileCppIcon,
  cs: FileCSharpIcon,
  sql: FileSqlIcon,
  db: FileSqlIcon,
  sqlite: FileSqlIcon,

  // Config
  ini: FileIniIcon,
  cfg: FileIniIcon,
  conf: FileIniIcon,
  toml: FileIniIcon,
  properties: FileIniIcon,
  env: FileLockIcon,
  pem: FileLockIcon,

  // Images
  png: FilePngIcon,
  jpg: FileJpgIcon,
  jpeg: FileJpgIcon,
  svg: FileSvgIcon,
  gif: FileImageIcon,
  webp: FileImageIcon,
  bmp: FileImageIcon,
  ico: FileImageIcon,
  avif: FileImageIcon,
  heic: FileImageIcon,
  heif: FileImageIcon,

  // Media
  mp3: FileAudioIcon,
  wav: FileAudioIcon,
  ogg: FileAudioIcon,
  flac: FileAudioIcon,
  m4a: FileAudioIcon,
  aac: FileAudioIcon,
  mp4: FileVideoIcon,
  webm: FileVideoIcon,
  mov: FileVideoIcon,
  avi: FileVideoIcon,
  mkv: FileVideoIcon,

  // Archives
  zip: FileZipIcon,
  rar: FileArchiveIcon,
  tar: FileArchiveIcon,
  gz: FileArchiveIcon,
  tgz: FileArchiveIcon,
  bz2: FileArchiveIcon,
  xz: FileArchiveIcon,
  '7z': FileArchiveIcon,

  // Code with no glyph of its own — the generic one is still better than text
  json: FileCodeIcon,
  jsonc: FileCodeIcon,
  json5: FileCodeIcon,
  yaml: FileCodeIcon,
  yml: FileCodeIcon,
  xml: FileCodeIcon,
  go: FileCodeIcon,
  rb: FileCodeIcon,
  java: FileCodeIcon,
  kt: FileCodeIcon,
  swift: FileCodeIcon,
  php: FileCodeIcon,
  sh: FileCodeIcon,
  bash: FileCodeIcon,
  zsh: FileCodeIcon,
  ps1: FileCodeIcon,
  svelte: FileCodeIcon,
};

/**
 * The icon for a file, by its name.
 *
 * Prefer this over {@link getFileIcon}: it answers with the glyph for THIS file
 * rather than for the broad category it belongs to.
 */
export function fileIconFor(filename: string): PhosphorIcon {
  // A name with no dot has no extension, and `split('.').pop()` hands back the
  // whole name — so a file called `key` or `css` would otherwise borrow the
  // Keynote or stylesheet glyph outright.
  if (!filename.includes('.')) return FileTextIcon;
  return ICON_BY_EXTENSION[getExtension(filename)] ?? FileTextIcon;
}
function getExtension(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() || '';
}

export type FileType =
  | 'image'
  | 'code'
  | 'text'
  | 'pdf'
  | 'audio'
  | 'video'
  | 'spreadsheet'
  | 'archive'
  | 'database'
  | 'markdown'
  | 'csv'
  | 'other';

/**
 * Get file type from filename
 */
export function getFileType(filename: string): FileType {
  const ext = getExtension(filename);

  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'heic', 'heif', 'avif'].includes(ext))
    return 'image';
  if (['js', 'jsx', 'ts', 'tsx', 'html', 'css', 'json', 'py', 'java', 'c', 'cpp'].includes(ext))
    return 'code';
  if (['txt', 'log', 'env'].includes(ext)) return 'text';
  if (['md', 'markdown'].includes(ext)) return 'markdown';
  if (ext === 'pdf') return 'pdf';
  if (['mp3', 'wav', 'ogg', 'flac'].includes(ext)) return 'audio';
  if (['mp4', 'webm', 'mov', 'avi'].includes(ext)) return 'video';
  if (['csv', 'tsv'].includes(ext)) return 'csv';
  if (['xls', 'xlsx'].includes(ext)) return 'spreadsheet';
  if (['zip', 'rar', 'tar', 'gz'].includes(ext)) return 'archive';
  if (['db', 'sqlite', 'sql'].includes(ext)) return 'database';

  return 'other';
}

/**
 * Generate human-readable display name for file type
 */
export function getTypeLabel(type: FileType, extension?: string): string {
  if (type === 'code' && extension) {
    return extension.toUpperCase();
  }

  const labels: Record<FileType, string> = {
    image: 'Image',
    code: 'Code',
    text: 'Text',
    markdown: 'Markdown',
    pdf: 'PDF',
    audio: 'Audio',
    video: 'Video',
    spreadsheet: 'Spreadsheet',
    csv: 'CSV',
    archive: 'Archive',
    database: 'Database',
    other: 'File',
  };

  return labels[type];
}

/**
 * Generate realistic file size estimate based on file path and type
 */
export function getFileSize(filepath: string, type: FileType): string {
  // Base size calculation
  const base = ((filepath.length * 5) % 800) + 200;

  // Type-specific multipliers
  const multipliers: Record<FileType, number> = {
    image: 5.0,
    video: 20.0,
    audio: 10.0,
    code: 0.5,
    text: 0.3,
    markdown: 0.3,
    pdf: 8.0,
    spreadsheet: 3.0,
    csv: 2.0,
    archive: 5.0,
    database: 4.0,
    other: 1.0,
  };

  const size = base * multipliers[type];

  if (size < 1024) return `${Math.round(size)} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Get a normalized file path for content access.
 * Previously constructed sandbox API URLs — now just returns the normalized path.
 * Content is loaded via OpenCode server's readFile() / useFileContent().
 */
export function getFileUrl(_sandboxId: string | undefined, path: string): string {
  // Handle paths that start with "workspace" (without leading /)
  if (path === 'workspace' || path.startsWith('workspace/')) {
    path = '/' + path;
  } else if (!path.startsWith('/workspace')) {
    path = `/workspace/${path.startsWith('/') ? path.substring(1) : path}`;
  }

  // Handle any potential Unicode escape sequences
  try {
    path = path.replace(/\\u([0-9a-fA-F]{4})/g, (_, hexCode) => {
      return String.fromCharCode(parseInt(hexCode, 16));
    });
  } catch (e) {
    console.error('Error processing Unicode escapes in path:', e);
  }

  return path;
}

/**
 * Extract filename from filepath
 */
export function getFilename(filepath: string): string {
  return filepath.split('/').pop() || 'file';
}

/**
 * Detect whether a File is an image, falling back to extension sniffing
 * for cases where the MIME type is missing (e.g. pasted files).
 */
export function isImageFile(file: File): boolean {
  if (file.type.startsWith('image/')) return true;
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  return [
    'jpg',
    'jpeg',
    'png',
    'gif',
    'webp',
    'svg',
    'bmp',
    'ico',
    'heic',
    'heif',
    'avif',
  ].includes(ext);
}
