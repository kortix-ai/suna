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
