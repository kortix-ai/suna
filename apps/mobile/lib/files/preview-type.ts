/**
 * File preview classification, moved out of `FilePreviewRenderers.tsx`
 * (KRTX-1292) so the data hook and the preview limits can import it without
 * importing the renderer (which imports react-native-webview and the whole
 * renderer graph). `FilePreviewRenderers` re-exports these names for its
 * callers.
 */


// File preview type enum
export enum FilePreviewType {
  IMAGE = 'image',
  PDF = 'pdf',
  MARKDOWN = 'markdown',
  MERMAID = 'mermaid',
  CSV = 'csv',
  XLSX = 'xlsx',
  DOCX = 'docx',
  HTML = 'html',
  JSON = 'json',
  CODE = 'code',
  TEXT = 'text',
  BINARY = 'binary',
  OTHER = 'other',
}

// Helper to get file preview type
export function getFilePreviewType(filename: string): FilePreviewType {
  const ext = filename.split('.').pop()?.toLowerCase() || '';

  const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'ico', 'heic', 'heif', 'tiff'];
  const documentExtensions = ['pdf'];
  const markdownExtensions = ['md', 'markdown', 'mdx'];
  const csvExtensions = ['csv', 'tsv'];
  const xlsxExtensions = ['xlsx', 'xls'];
  const docxExtensions = ['docx'];
  const htmlExtensions = ['html', 'htm'];
  const jsonExtensions = ['json', 'jsonc', 'json5'];
  const codeExtensions = [
    'js', 'jsx', 'ts', 'tsx', 'py', 'pyi', 'pyx', 'pyw',
    'java', 'c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'hxx', 'm', 'mm',
    'cs', 'rb', 'erb', 'go', 'rs', 'php', 'swift', 'kt', 'kts', 'scala',
    'r', 'rmd', 'hs', 'lhs', 'lua', 'perl', 'pl', 'pm',
    'sql', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
    'css', 'scss', 'sass', 'less', 'styl',
    'yaml', 'yml', 'toml', 'ini', 'conf', 'config', 'cfg', 'properties',
    'xml', 'xsl', 'xslt', 'wsdl',
    'dart', 'vim', 'dockerfile', 'makefile',
    'vue', 'svelte',
    'proto', 'graphql', 'gql',
    'gradle', 'groovy', 'clj', 'cljs', 'ex', 'exs',
    'f90', 'f95', 'f03', 'for',
    'zig', 'nim', 'v', 'cr', 'jl',
    'env', 'gitignore', 'editorconfig',
  ];
  const textExtensions = ['txt', 'log', 'rtf', 'tex', 'rst', 'org', 'nfo', 'info'];
  const binaryExtensions = ['zip', 'tar', 'gz', 'rar', '7z', 'exe', 'dmg', 'pkg', 'deb', 'rpm'];

  // SVG is never drawn on mobile (Jay, 2026-09-22, `lib/files/svg-policy`):
  // it reads as its markup, so Copy works, and Download hands the real file to
  // the device. The `SvgXml` renderer that briefly lived here is gone.
  if (ext === 'mmd' || ext === 'mermaid') return FilePreviewType.MERMAID;
  if (ext === 'svg') return FilePreviewType.TEXT;
  if (imageExtensions.includes(ext)) return FilePreviewType.IMAGE;
  if (documentExtensions.includes(ext)) return FilePreviewType.PDF;
  if (markdownExtensions.includes(ext)) return FilePreviewType.MARKDOWN;
  if (csvExtensions.includes(ext)) return FilePreviewType.CSV;
  if (xlsxExtensions.includes(ext)) return FilePreviewType.XLSX;
  if (docxExtensions.includes(ext)) return FilePreviewType.DOCX;
  if (htmlExtensions.includes(ext)) return FilePreviewType.HTML;
  if (jsonExtensions.includes(ext)) return FilePreviewType.JSON;
  if (codeExtensions.includes(ext)) return FilePreviewType.CODE;
  if (textExtensions.includes(ext)) return FilePreviewType.TEXT;
  if (binaryExtensions.includes(ext)) return FilePreviewType.BINARY;

  return FilePreviewType.OTHER;
}

// Helper to get language for syntax highlighting
export function getLanguageFromFilename(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';

  const languageMap: Record<string, string> = {
    'js': 'javascript', 'jsx': 'javascript', 'mjs': 'javascript', 'cjs': 'javascript',
    'ts': 'typescript', 'tsx': 'typescript',
    'py': 'python', 'pyi': 'python', 'pyx': 'python', 'pyw': 'python',
    'rb': 'ruby', 'erb': 'ruby', 'gemspec': 'ruby',
    'java': 'java',
    'c': 'c', 'h': 'c', 'm': 'objectivec',
    'cpp': 'cpp', 'cc': 'cpp', 'cxx': 'cpp', 'hpp': 'cpp', 'hxx': 'cpp', 'mm': 'objectivec',
    'cs': 'csharp',
    'go': 'go',
    'rs': 'rust',
    'php': 'php',
    'swift': 'swift',
    'kt': 'kotlin', 'kts': 'kotlin',
    'scala': 'scala',
    'r': 'r', 'rmd': 'r',
    'hs': 'haskell', 'lhs': 'haskell',
    'lua': 'lua',
    'perl': 'perl', 'pl': 'perl', 'pm': 'perl',
    'sql': 'sql',
    'sh': 'bash', 'bash': 'bash', 'zsh': 'bash', 'fish': 'bash',
    'ps1': 'powershell', 'bat': 'dos', 'cmd': 'dos',
    'css': 'css', 'scss': 'scss', 'sass': 'scss', 'less': 'less',
    'html': 'html', 'htm': 'html',
    'xml': 'xml', 'xsl': 'xml', 'xslt': 'xml', 'wsdl': 'xml',
    'yaml': 'yaml', 'yml': 'yaml',
    'toml': 'ini', 'ini': 'ini', 'conf': 'ini', 'cfg': 'ini', 'properties': 'properties',
    'json': 'json', 'jsonc': 'json', 'json5': 'json',
    'md': 'markdown', 'mdx': 'markdown',
    'dart': 'dart',
    'vim': 'vim',
    'vue': 'xml', 'svelte': 'xml',
    'proto': 'protobuf', 'graphql': 'graphql', 'gql': 'graphql',
    'gradle': 'gradle', 'groovy': 'groovy',
    'clj': 'clojure', 'cljs': 'clojure',
    'ex': 'elixir', 'exs': 'elixir',
    'jl': 'julia',
    'zig': 'zig', 'nim': 'nim',
    'dockerfile': 'dockerfile', 'makefile': 'makefile',
  };

  return languageMap[ext] || 'plaintext';
}
/**
 * How a preview's content reaches the renderer: as text (the hook fetches and
 * the renderer truncates), as a base64 blob (image / PDF / DOCX), or not at
 * all — spreadsheets and unknown binaries download instead of loading.
 */
export function previewFetchKind(previewType: FilePreviewType): 'text' | 'blob' | 'none' {
  switch (previewType) {
    case FilePreviewType.IMAGE:
    case FilePreviewType.PDF:
    case FilePreviewType.DOCX:
      return 'blob';
    case FilePreviewType.XLSX:
    case FilePreviewType.BINARY:
      return 'none';
    default:
      return 'text';
  }
}
