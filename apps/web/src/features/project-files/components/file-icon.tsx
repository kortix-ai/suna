import { cn } from '@/lib/utils';
import {
  Folder,
  FolderOpen,
  FileText,
  FileCode,
  FileCode2,
  FileImage,
  FileVideo,
  FileSpreadsheet,
  FileType,
  FileJson,
  FileTerminal,
  FileArchive,
  FileAudio,
  FileCog,
  FileKey,
  FileLock,
  FileMusic,
  FileBadge,
  FileBox,
  FileChartLine,
  Database,
  File as FileIcon,
} from 'lucide-react';

export type FileIconVariant = 'monochrome' | 'colored';

/**
 * Returns an icon element for a given filename.
 *
 * variant='monochrome' (default): Clean Google Drive-style grey icons
 * variant='colored': Legacy colored icons for contexts that need them
 *
 * @param fileName  The file or directory name (e.g. "index.tsx")
 * @param options   className, isDirectory, isOpen (for open folders), variant
 */
export function getFileIcon(
  fileName: string,
  {
    className,
    isDirectory,
    isOpen,
    variant = 'monochrome',
  }: {
    className?: string;
    isDirectory?: boolean;
    isOpen?: boolean;
    variant?: FileIconVariant;
  } = {},
) {
  const ic = className ?? 'h-4 w-4 shrink-0';

  if (variant === 'colored') {
    return getColoredIcon(fileName, ic, isDirectory);
  }

  return getMonochromeIcon(fileName, ic, isDirectory, isOpen);
}

/**
 * Monochrome Google Drive-style icons.
 * All icons use text-muted-foreground for a clean, uniform look.
 * Folders get a slightly different treatment.
 */
function getMonochromeIcon(fileName: string, ic: string, isDirectory?: boolean, isOpen?: boolean) {
  const mono = `${ic} text-muted-foreground`;

  if (isDirectory) {
    return isOpen
      ? <FolderOpen className={cn(ic, 'text-muted-foreground')} />
      : <Folder className={cn(ic, 'text-muted-foreground')} />;
  }

  const name = fileName.toLowerCase();
  const ext = name.split('.').pop() || '';

  // ── Special filenames ──────────────────────────────────────────
  if (name === 'dockerfile' || name.startsWith('docker-compose')) {
    return <FileBox className={mono} />;
  }
  if (name === '.env' || name.startsWith('.env.')) {
    return <FileKey className={mono} />;
  }
  if (['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'].includes(name)) {
    return <FileBox className={mono} />;
  }
  if (['license', 'license.md', 'license.txt'].includes(name)) {
    return <FileBadge className={mono} />;
  }
  if (['.gitignore', '.gitattributes', '.gitmodules'].includes(name)) {
    return <FileCog className={mono} />;
  }
  if (['makefile', 'cmakelists.txt'].includes(name)) {
    return <FileTerminal className={mono} />;
  }

  // ── By extension ───────────────────────────────────────────────

  // Code files
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte'].includes(ext)) {
    return <FileCode2 className={mono} />;
  }
  if (['py', 'pyi', 'pyx', 'pyw', 'rs', 'go', 'rb', 'erb', 'gemspec', 'java', 'kt', 'kts',
    'c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'hxx', 'm', 'mm', 'cs', 'swift', 'php',
    'html', 'htm', 'css', 'scss', 'sass', 'less', 'styl'].includes(ext)) {
    return <FileCode className={mono} />;
  }

  // Data / config
  if (['json', 'jsonc', 'json5'].includes(ext)) {
    return <FileJson className={mono} />;
  }
  if (['yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'editorconfig'].includes(ext)) {
    return <FileCog className={mono} />;
  }
  if (['xml', 'xsl', 'xslt', 'wsdl'].includes(ext)) {
    return <FileCode className={mono} />;
  }

  // Shell
  if (['sh', 'bash', 'zsh', 'fish', 'bat', 'cmd', 'ps1'].includes(ext)) {
    return <FileTerminal className={mono} />;
  }

  // Text / docs
  if (['md', 'mdx', 'txt', 'rst', 'rtf'].includes(ext)) {
    return <FileText className={mono} />;
  }

  // Images
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'avif', 'tiff', 'tif', 'heic', 'heif'].includes(ext)) {
    return <FileImage className={mono} />;
  }

  // Video
  if (['mp4', 'webm', 'avi', 'mov', 'mkv', 'flv', 'wmv', 'ogv'].includes(ext)) {
    return <FileVideo className={mono} />;
  }

  // Audio
  if (['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma', 'opus'].includes(ext)) {
    return <FileAudio className={mono} />;
  }
  if (['mid', 'midi'].includes(ext)) {
    return <FileMusic className={mono} />;
  }

  // Spreadsheets
  if (['xlsx', 'xls', 'csv', 'tsv', 'ods'].includes(ext)) {
    return <FileSpreadsheet className={mono} />;
  }

  // SQLite databases
  if (['db', 'sqlite', 'sqlite3', 'db3', 'sdb', 's3db'].includes(ext)) {
    return <Database className={mono} />;
  }

  // PDF / Documents
  if (ext === 'pdf') {
    return <FileType className={mono} />;
  }
  if (['doc', 'docx', 'odt'].includes(ext)) {
    return <FileType className={mono} />;
  }
  if (['ppt', 'pptx', 'odp'].includes(ext)) {
    return <FileType className={mono} />;
  }

  // Archives
  if (['zip', 'tar', 'gz', 'bz2', 'xz', 'rar', '7z', 'tgz', 'zst'].includes(ext)) {
    return <FileArchive className={mono} />;
  }

  // Lock / security
  if (['lock', 'pem', 'crt', 'cer', 'key'].includes(ext)) {
    return <FileLock className={mono} />;
  }

  // Database / SQL
  if (['sql', 'sqlite', 'db', 'sqlite3'].includes(ext)) {
    return <FileChartLine className={mono} />;
  }

  // Protobuf / GraphQL
  if (['proto', 'graphql', 'gql'].includes(ext)) {
    return <FileCode2 className={mono} />;
  }

  // WASM
  if (['wasm', 'wat'].includes(ext)) {
    return <FileBox className={mono} />;
  }

  // Log files
  if (ext === 'log') {
    return <FileText className={mono} />;
  }

  // RC / config dotfiles
  if (name.startsWith('.') && (name.endsWith('rc') || name.endsWith('rc.js') || name.endsWith('rc.json') || name.endsWith('rc.yml'))) {
    return <FileCog className={mono} />;
  }
  if (name.includes('eslint') || name.includes('prettier') || name.includes('babel')) {
    return <FileCog className={mono} />;
  }
  if (name.startsWith('tsconfig') || name.startsWith('jsconfig')) {
    return <FileCog className={mono} />;
  }

  // Fallback
  return <FileIcon className={mono} />;
}

/**
 * Colored icons (legacy) - kept for backward compatibility with contexts
 * that still want colored file type indicators.
 */
function getColoredIcon(fileName: string, ic: string, isDirectory?: boolean) {
  if (isDirectory) {
    return <Folder className={cn(ic, 'text-blue-400')} />;
  }

  const name = fileName.toLowerCase();
  const ext = name.split('.').pop() || '';

  // Special filenames
  if (name === 'dockerfile' || name.startsWith('docker-compose')) return <FileBox className={cn(ic, 'text-sky-400')} />;
  if (name === '.env' || name.startsWith('.env.')) return <FileKey className={cn(ic, 'text-yellow-500')} />;
  if (['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'].includes(name)) return <FileBox className={cn(ic, 'text-green-400')} />;
  if (['license', 'license.md', 'license.txt'].includes(name)) return <FileBadge className={cn(ic, 'text-amber-400')} />;
  if (['.gitignore', '.gitattributes', '.gitmodules'].includes(name)) return <FileCog className={cn(ic, 'text-orange-400')} />;
  if (['makefile', 'cmakelists.txt'].includes(name)) return <FileTerminal className={cn(ic, 'text-amber-500')} />;

  // TypeScript / JavaScript
  if (['ts', 'tsx'].includes(ext)) return <FileCode2 className={cn(ic, 'text-blue-400')} />;
  if (['js', 'jsx', 'mjs', 'cjs'].includes(ext)) return <FileCode2 className={cn(ic, 'text-yellow-400')} />;

  // Python
  if (['py', 'pyi', 'pyx', 'pyw'].includes(ext)) return <FileCode className={cn(ic, 'text-sky-400')} />;

  // Other langs
  if (ext === 'rs') return <FileCode className={cn(ic, 'text-orange-400')} />;
  if (ext === 'go') return <FileCode className={cn(ic, 'text-cyan-400')} />;
  if (['rb', 'erb', 'gemspec'].includes(ext)) return <FileCode className={cn(ic, 'text-red-400')} />;
  if (['java', 'kt', 'kts'].includes(ext)) return <FileCode className={cn(ic, 'text-orange-500')} />;
  if (['c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'hxx', 'm', 'mm'].includes(ext)) return <FileCode className={cn(ic, 'text-blue-500')} />;
  if (ext === 'cs') return <FileCode className={cn(ic, 'text-violet-400')} />;
  if (ext === 'swift') return <FileCode className={cn(ic, 'text-orange-400')} />;
  if (ext === 'php') return <FileCode className={cn(ic, 'text-indigo-400')} />;
  if (ext === 'vue') return <FileCode2 className={cn(ic, 'text-emerald-400')} />;
  if (ext === 'svelte') return <FileCode2 className={cn(ic, 'text-orange-500')} />;
  if (['html', 'htm'].includes(ext)) return <FileCode className={cn(ic, 'text-orange-400')} />;
  if (['css', 'scss', 'sass', 'less', 'styl'].includes(ext)) return <FileCode className={cn(ic, 'text-pink-400')} />;

  // Data formats
  if (['json', 'jsonc', 'json5'].includes(ext)) return <FileJson className={cn(ic, 'text-yellow-500')} />;
  if (['yaml', 'yml', 'toml'].includes(ext)) return <FileCog className={cn(ic, 'text-purple-400')} />;
  if (['xml', 'xsl', 'xslt', 'wsdl'].includes(ext)) return <FileCode className={cn(ic, 'text-amber-500')} />;

  // Shell
  if (['sh', 'bash', 'zsh', 'fish', 'bat', 'cmd', 'ps1'].includes(ext)) return <FileTerminal className={cn(ic, 'text-green-400')} />;

  // Text / docs
  if (['md', 'mdx', 'txt', 'rst', 'rtf'].includes(ext)) return <FileText className={cn(ic, 'text-muted-foreground')} />;

  // Media
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'avif', 'tiff', 'tif', 'heic', 'heif'].includes(ext)) return <FileImage className={cn(ic, 'text-purple-400')} />;
  if (['mp4', 'webm', 'avi', 'mov', 'mkv', 'flv', 'wmv', 'ogv'].includes(ext)) return <FileVideo className={cn(ic, 'text-pink-400')} />;
  if (['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma', 'opus'].includes(ext)) return <FileAudio className={cn(ic, 'text-teal-400')} />;
  if (['mid', 'midi'].includes(ext)) return <FileMusic className={cn(ic, 'text-teal-400')} />;

  // Spreadsheets
  if (['xlsx', 'xls', 'csv', 'tsv', 'ods'].includes(ext)) return <FileSpreadsheet className={cn(ic, 'text-green-400')} />;

  // SQLite databases
  if (['db', 'sqlite', 'sqlite3', 'db3', 'sdb', 's3db'].includes(ext)) return <Database className={cn(ic, 'text-blue-400')} />;

  // PDF / Documents
  if (ext === 'pdf') return <FileType className={cn(ic, 'text-red-500')} />;
  if (['doc', 'docx', 'odt'].includes(ext)) return <FileType className={cn(ic, 'text-blue-500')} />;
  if (['ppt', 'pptx', 'odp'].includes(ext)) return <FileType className={cn(ic, 'text-orange-500')} />;

  // Archives
  if (['zip', 'tar', 'gz', 'bz2', 'xz', 'rar', '7z', 'tgz', 'zst'].includes(ext)) return <FileArchive className={cn(ic, 'text-amber-500')} />;

  // Config
  if (['ini', 'cfg', 'conf', 'properties', 'editorconfig'].includes(ext)) return <FileCog className={cn(ic, 'text-gray-400')} />;
  if (name.startsWith('.') && (name.endsWith('rc') || name.endsWith('rc.js') || name.endsWith('rc.json') || name.endsWith('rc.yml'))) return <FileCog className={cn(ic, 'text-gray-400')} />;
  if (name.includes('eslint') || name.includes('prettier') || name.includes('babel')) return <FileCog className={cn(ic, 'text-purple-400')} />;
  if (name.startsWith('tsconfig') || name.startsWith('jsconfig')) return <FileCog className={cn(ic, 'text-blue-400')} />;

  // Lock / security
  if (['lock', 'pem', 'crt', 'cer', 'key'].includes(ext)) return <FileLock className={cn(ic, 'text-yellow-500')} />;

  // Database
  if (['sql', 'sqlite', 'db', 'sqlite3'].includes(ext)) return <FileChartLine className={cn(ic, 'text-blue-400')} />;

  // Other
  if (['proto', 'graphql', 'gql'].includes(ext)) return <FileCode2 className={cn(ic, 'text-pink-500')} />;
  if (['wasm', 'wat'].includes(ext)) return <FileBox className={cn(ic, 'text-violet-500')} />;
  if (ext === 'log') return <FileText className={cn(ic, 'text-gray-400')} />;

  return <FileIcon className={cn(ic, 'text-muted-foreground')} />;
}
