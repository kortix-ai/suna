/**
 * Shared upload limits and file type definitions
 * Used across web, mobile, and backend
 */

export const UPLOAD_LIMITS = {
  MAX_FILE_SIZE_BYTES: 50 * 1024 * 1024,
  MAX_FILE_SIZE_MB: 50,
  MAX_PDF_PAGES: 500,
  MAX_EXCEL_ROWS: 100_000,
  MAX_EXCEL_SHEETS: 50,
  MAX_TEXT_CHARS: 10_000_000,
  MAX_ZIP_FILES: 50,
  MAX_ZIP_TOTAL_SIZE_BYTES: 100 * 1024 * 1024,
} as const;

export const ALLOWED_EXTENSIONS = [
  // Documents
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.odt', '.ods', '.odp', '.rtf', '.epub',

  // Text & Markup
  '.txt', '.csv', '.md', '.markdown', '.html', '.htm', '.css',

  // Code
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.py', '.pyw', '.pyi',
  '.java', '.class',
  '.c', '.cpp', '.h', '.hpp', '.cc', '.cxx',
  '.cs',
  '.go',
  '.rs',
  '.rb',
  '.php',
  '.swift',
  '.kt', '.kts',
  '.scala',
  '.sh', '.bash', '.zsh',
  '.sql',
  '.r',
  '.m',
  '.lua',
  '.pl',
  '.dart',

  // Config & Data
  '.yaml', '.yml', '.toml', '.xml', '.json', '.jsonc', '.json5',
  '.env', '.ini', '.cfg', '.conf',
  '.lock',

  // Web & Templates
  '.vue', '.svelte', '.astro',
  '.ejs', '.pug', '.hbs', '.handlebars',

  // Images
  '.jpeg', '.jpg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico',
  '.heic', '.heif', '.tiff', '.tif',

  // Video
  '.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v', '.flv', '.wmv',

  // Audio
  '.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.wma',

  // Archives
  '.zip', '.tar', '.gz', '.7z', '.rar', '.bz2', '.xz',

  // Fonts
  '.ttf', '.otf', '.woff', '.woff2', '.eot',

  // 3D & Design
  '.svg', '.ai', '.sketch', '.fig', '.xd',
  '.obj', '.stl', '.gltf', '.glb', '.fbx',

  // Binary & Executables (for development/analysis)
  '.bin', '.exe', '.dll', '.so', '.dylib',
  '.wasm',

  // Database
  '.db', '.sqlite', '.sqlite3',

  // Notebooks
  '.ipynb',

  // Canvas
  '.kanvax',
] as const;

export const EXTRACTABLE_EXTENSIONS = ['.zip'] as const;

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function isAllowedFile(file: { name: string; size?: number }): { allowed: boolean; reason?: string } {
  const ext = '.' + file.name.split('.').pop()?.toLowerCase();

  if (!ALLOWED_EXTENSIONS.includes(ext as any)) {
    return { allowed: false, reason: `File type ${ext} is not supported` };
  }

  if (file.size && file.size > UPLOAD_LIMITS.MAX_FILE_SIZE_BYTES) {
    return {
      allowed: false,
      reason: `File size (${formatFileSize(file.size)}) exceeds ${UPLOAD_LIMITS.MAX_FILE_SIZE_MB}MB limit`
    };
  }

  return { allowed: true };
}

export function isExtractableArchive(file: { name: string }): boolean {
  const ext = '.' + file.name.split('.').pop()?.toLowerCase();
  return EXTRACTABLE_EXTENSIONS.includes(ext as any);
}
