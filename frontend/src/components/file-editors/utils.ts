// Process Unicode escape sequences in content
export const processUnicodeContent = (content: any, forCodeBlock: boolean = false): string => {
  // Handle different content types
  if (!content) {
    return '';
  }

  // If it's an object (like JSON), stringify it
  if (typeof content === 'object') {
    try {
      const jsonString = JSON.stringify(content, null, 2);
      // Only wrap in markdown if not for code block (to avoid double-wrapping)
      if (forCodeBlock) {
        return jsonString;
      } else {
        return '```json\n' + jsonString + '\n```';
      }
    } catch (error) {
      console.warn('Failed to stringify object:', error);
      return String(content);
    }
  }

  // If it's not a string, convert to string
  if (typeof content !== 'string') {
    return String(content);
  }

  // Process \uXXXX Unicode escape sequences (BMP characters)
  const bmpProcessed = content.replace(
    /\\u([0-9a-fA-F]{4})/g,
    (_, codePoint) => {
      return String.fromCharCode(parseInt(codePoint, 16));
    },
  );

  // Process \uXXXXXXXX Unicode escape sequences (supplementary plane characters)
  return bmpProcessed.replace(/\\u([0-9a-fA-F]{8})/g, (_, codePoint) => {
    const highSurrogate = parseInt(codePoint.substring(0, 4), 16);
    const lowSurrogate = parseInt(codePoint.substring(4, 8), 16);
    return String.fromCharCode(highSurrogate, lowSurrogate);
  });
};

// Helper function to get file type from extension
export function getFileTypeFromExtension(fileName: string): string {
  const extension = fileName.split('.').pop()?.toLowerCase() || '';

  const markdownExtensions = ['md', 'markdown'];
  const codeExtensions = [
    'js', 'jsx', 'ts', 'tsx', 'html', 'css', 'json', 'doc',
    'py', 'python', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs',
    'php', 'rb', 'sh', 'bash', 'xml', 'yml', 'yaml', 'toml',
    'sql', 'graphql', 'swift', 'kotlin', 'dart', 'r', 'lua',
    'scala', 'perl', 'haskell', 'rust',
  ];
  const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'];
  const pdfExtensions = ['pdf'];
  const csvExtensions = ['csv', 'tsv'];
  const xlsxExtensions = ['xlsx', 'xls'];
  const pptxExtensions = ['pptx', 'ppt'];
  const textExtensions = ['txt', 'log', 'env', 'ini'];

  if (markdownExtensions.includes(extension)) return 'markdown';
  if (codeExtensions.includes(extension)) return 'code';
  if (imageExtensions.includes(extension)) return 'image';
  if (pdfExtensions.includes(extension)) return 'pdf';
  if (csvExtensions.includes(extension)) return 'csv';
  if (xlsxExtensions.includes(extension)) return 'xlsx';
  if (pptxExtensions.includes(extension)) return 'pptx';
  if (textExtensions.includes(extension)) return 'text';
  
  return 'binary';
}

// Helper function to get language from file extension for code highlighting
export function getLanguageFromExtension(fileName: string): string {
  const extension = fileName.split('.').pop()?.toLowerCase() || '';

  const extensionToLanguage: Record<string, string> = {
    js: 'javascript',
    jsx: 'jsx',
    ts: 'typescript',
    tsx: 'tsx',
    html: 'html',
    css: 'css',
    json: 'json',
    py: 'python',
    python: 'python',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    cs: 'csharp',
    go: 'go',
    rs: 'rust',
    php: 'php',
    rb: 'ruby',
    sh: 'shell',
    bash: 'shell',
    xml: 'xml',
    yml: 'yaml',
    yaml: 'yaml',
    sql: 'sql',
  };

  return extensionToLanguage[extension] || '';
}


