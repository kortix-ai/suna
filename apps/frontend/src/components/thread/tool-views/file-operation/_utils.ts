import { LucideIcon, FilePen, Replace, Trash2, FileCode, FileSpreadsheet, File } from 'lucide-react';

export type DiffType = 'unchanged' | 'added' | 'removed';

export interface LineDiff {
  type: DiffType;
  oldLine: string | null;
  newLine: string | null;
  lineNumber: number;
}

export interface CharDiffPart {
  text: string;
  type: DiffType;
}

export interface DiffStats {
  additions: number;
  deletions: number;
}

export const parseNewlines = (text: string): string => {
  return text.replace(/\\n/g, '\n');
};

export const generateLineDiff = (oldText: string, newText: string): LineDiff[] => {
  const parsedOldText = parseNewlines(oldText);
  const parsedNewText = parseNewlines(newText);
  
  const oldLines = parsedOldText.split('\n');
  const newLines = parsedNewText.split('\n');
  
  const diffLines: LineDiff[] = [];
  const maxLines = Math.max(oldLines.length, newLines.length);
  
  for (let i = 0; i < maxLines; i++) {
    const oldLine = i < oldLines.length ? oldLines[i] : null;
    const newLine = i < newLines.length ? newLines[i] : null;
    
    if (oldLine === newLine) {
      diffLines.push({ type: 'unchanged', oldLine, newLine, lineNumber: i + 1 });
    } else {
      if (oldLine !== null) {
        diffLines.push({ type: 'removed', oldLine, newLine: null, lineNumber: i + 1 });
      }
      if (newLine !== null) {
        diffLines.push({ type: 'added', oldLine: null, newLine, lineNumber: i + 1 });
      }
    }
  }
  
  return diffLines;
};

export const generateCharDiff = (oldText: string, newText: string): CharDiffPart[] => {
  const parsedOldText = parseNewlines(oldText);
  const parsedNewText = parseNewlines(newText);
  
  let prefixLength = 0;
  while (
    prefixLength < parsedOldText.length &&
    prefixLength < parsedNewText.length &&
    parsedOldText[prefixLength] === parsedNewText[prefixLength]
  ) {
    prefixLength++;
  }

  let oldSuffixStart = parsedOldText.length;
  let newSuffixStart = parsedNewText.length;
  while (
    oldSuffixStart > prefixLength &&
    newSuffixStart > prefixLength &&
    parsedOldText[oldSuffixStart - 1] === parsedNewText[newSuffixStart - 1]
  ) {
    oldSuffixStart--;
    newSuffixStart--;
  }

  const parts: CharDiffPart[] = [];

  if (prefixLength > 0) {
    parts.push({
      text: parsedOldText.substring(0, prefixLength),
      type: 'unchanged',
    });
  }

  if (oldSuffixStart > prefixLength) {
    parts.push({
      text: parsedOldText.substring(prefixLength, oldSuffixStart),
      type: 'removed',
    });
  }
  if (newSuffixStart > prefixLength) {
    parts.push({
      text: parsedNewText.substring(prefixLength, newSuffixStart),
      type: 'added',
    });
  }

  if (oldSuffixStart < parsedOldText.length) {
    parts.push({
      text: parsedOldText.substring(oldSuffixStart),
      type: 'unchanged',
    });
  }

  return parts;
};

export const calculateDiffStats = (lineDiff: LineDiff[]): DiffStats => {
  return {
    additions: lineDiff.filter(line => line.type === 'added').length,
    deletions: lineDiff.filter(line => line.type === 'removed').length
  };
};

export type FileOperation = 'create' | 'rewrite' | 'delete' | 'edit' | 'str-replace';

export interface OperationConfig {
  icon: LucideIcon;
  color: string;
  successMessage: string;
  progressMessage: string;
  bgColor: string;
  gradientBg: string;
  borderColor: string;
  badgeColor: string;
  hoverColor: string;
}

export const getLanguageFromFileName = (fileName: string): string => {
  const extension = fileName.split('.').pop()?.toLowerCase() || '';

  const extensionMap: Record<string, string> = {
    // Web languages
    html: 'html',
    htm: 'html',
    css: 'css',
    scss: 'scss',
    sass: 'scss',
    less: 'less',
    js: 'javascript',
    jsx: 'jsx',
    ts: 'typescript',
    tsx: 'tsx',
    json: 'json',
    jsonc: 'json',

    // Build and config files
    xml: 'xml',
    yml: 'yaml',
    yaml: 'yaml',
    toml: 'toml',
    ini: 'ini',
    env: 'bash',
    gitignore: 'bash',
    dockerignore: 'bash',

    // Scripting languages
    py: 'python',
    rb: 'ruby',
    php: 'php',
    go: 'go',
    java: 'java',
    kt: 'kotlin',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    swift: 'swift',
    rs: 'rust',

    // Shell scripts
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    ps1: 'powershell',
    bat: 'batch',
    cmd: 'batch',

    // Markup languages (excluding markdown which has its own renderer)
    svg: 'svg',
    tex: 'latex',

    // Data formats
    graphql: 'graphql',
    gql: 'graphql',
  };

  return extensionMap[extension] || 'text';
};

export interface ExtractedEditData {
  filePath: string | null;
  originalContent: string | null;
  updatedContent: string | null;
  success?: boolean;
  timestamp?: string;
  errorMessage?: string;
}

const parseContent = (content: any): any => {
  if (typeof content === 'string') {
    try {
      return JSON.parse(content);
    } catch (e) {
      return content;
    }
  }
  return content;
};

const parseOutput = (output: any) => {
    if (typeof output === 'string') {
      try {
        return JSON.parse(output);
      } catch {
        return output; // Return as string if not JSON
      }
    }
    return output;
  };

export const extractFileEditData = (
  toolCall: { arguments?: Record<string, any> },
  toolResult?: { output?: any; success?: boolean },
  isSuccess: boolean = true,
  toolTimestamp?: string,
  assistantTimestamp?: string
): {
  filePath: string | null;
  originalContent: string | null;
  updatedContent: string | null;
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
  errorMessage?: string;
} => {
  // Extract from structured metadata
  const args = toolCall?.arguments || {};
  const output = toolResult?.output;
  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : isSuccess;

  let filePath: string | null = args.target_file || args.file_path || null;
  let originalContent: string | null = null;
  let updatedContent: string | null = null;
  let errorMessage: string | undefined;

  if (output) {
    if (typeof output === 'object' && output !== null) {
      // Structured output from metadata
      filePath = filePath || output.file_path || output.target_file || null;
      originalContent = output.original_content ?? null;
      updatedContent = output.updated_content ?? output.file_content ?? output.content ?? null;
      
      if (actualIsSuccess === false) {
        errorMessage = output.message || output.error || null;
      }
        } else if (typeof output === 'string') {
      // String output - might be error message
      if (actualIsSuccess === false) {
          errorMessage = output;
      }
    }
  }

        return {
    filePath,
    originalContent,
    updatedContent,
    actualIsSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp,
    errorMessage,
  };
};

export const getOperationType = (name?: string, assistantContent?: any): FileOperation => {
  if (name) {
    if (name.includes('create')) return 'create';
    if (name.includes('rewrite')) return 'rewrite';
    if (name.includes('delete')) return 'delete';
    if (name.includes('edit-file')) return 'edit'; // Specific for edit_file
    if (name.includes('str-replace')) return 'str-replace';
  }

  if (!assistantContent) return 'create';

  // Assuming normalizeContentToString is imported from existing utils
  const contentStr = typeof assistantContent === 'string' ? assistantContent : JSON.stringify(assistantContent);
  if (!contentStr) return 'create';

  if (contentStr.includes('<create-file>')) return 'create';
  if (contentStr.includes('<full-file-rewrite>')) return 'rewrite';
  if (contentStr.includes('<edit-file>')) return 'edit';
  if (
    contentStr.includes('delete-file') ||
    contentStr.includes('<delete>')
  )
    return 'delete';

  if (contentStr.toLowerCase().includes('create file')) return 'create';
  if (contentStr.toLowerCase().includes('rewrite file'))
    return 'rewrite';
  if (contentStr.toLowerCase().includes('edit file')) return 'edit';
  if (contentStr.toLowerCase().includes('delete file')) return 'delete';

  return 'create';
};

export const getOperationConfigs = (): Record<FileOperation, OperationConfig> => {
  return {
  create: {
    icon: FilePen,
      color: 'text-zinc-700 dark:text-zinc-300',
    successMessage: 'File created successfully',
    progressMessage: 'Creating file...',
      bgColor: 'bg-zinc-50 dark:bg-zinc-900',
      gradientBg: 'from-zinc-50 to-zinc-100 dark:from-zinc-900 dark:to-zinc-800',
      borderColor: 'border-zinc-200 dark:border-zinc-700',
      badgeColor: 'bg-zinc-100 text-zinc-700 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-700',
      hoverColor: 'hover:bg-zinc-100 dark:hover:bg-zinc-800',
    },
    edit: {
      icon: Replace,
      color: 'text-zinc-700 dark:text-zinc-300',
      successMessage: 'File edited successfully',
      progressMessage: 'Editing file...',
      bgColor: 'bg-zinc-50 dark:bg-zinc-900',
      gradientBg: 'from-zinc-50 to-zinc-100 dark:from-zinc-900 dark:to-zinc-800',
      borderColor: 'border-zinc-200 dark:border-zinc-700',
      badgeColor: 'bg-zinc-100 text-zinc-700 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-700',
      hoverColor: 'hover:bg-zinc-100 dark:hover:bg-zinc-800',
  },
  rewrite: {
    icon: Replace,
      color: 'text-zinc-700 dark:text-zinc-300',
    successMessage: 'File rewritten successfully',
    progressMessage: 'Rewriting file...',
      bgColor: 'bg-zinc-50 dark:bg-zinc-900',
      gradientBg: 'from-zinc-50 to-zinc-100 dark:from-zinc-900 dark:to-zinc-800',
      borderColor: 'border-zinc-200 dark:border-zinc-700',
      badgeColor: 'bg-zinc-100 text-zinc-700 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-700',
      hoverColor: 'hover:bg-zinc-100 dark:hover:bg-zinc-800',
  },
  delete: {
    icon: Trash2,
      color: 'text-zinc-700 dark:text-zinc-300',
    successMessage: 'File deleted successfully',
    progressMessage: 'Deleting file...',
      bgColor: 'bg-zinc-50 dark:bg-zinc-900',
      gradientBg: 'from-zinc-50 to-zinc-100 dark:from-zinc-900 dark:to-zinc-800',
      borderColor: 'border-zinc-200 dark:border-zinc-700',
      badgeColor: 'bg-zinc-100 text-zinc-700 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-700',
      hoverColor: 'hover:bg-zinc-100 dark:hover:bg-zinc-800',
  },
  'str-replace': {
    icon: Replace,
    color: 'text-zinc-700 dark:text-zinc-300',
    successMessage: 'String replaced successfully',
    progressMessage: 'Replacing string...',
    bgColor: 'bg-zinc-50 dark:bg-zinc-900',
    gradientBg: 'from-zinc-50 to-zinc-100 dark:from-zinc-900 dark:to-zinc-800',
    borderColor: 'border-zinc-200 dark:border-zinc-700',
    badgeColor: 'bg-zinc-100 text-zinc-700 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-700',
    hoverColor: 'hover:bg-zinc-100 dark:hover:bg-zinc-800',
  },
  };
};

export const getFileIcon = (fileName: string): LucideIcon => {
  if (fileName.endsWith('.md')) return FileCode;
  if (fileName.endsWith('.csv')) return FileSpreadsheet;
  if (fileName.endsWith('.html')) return FileCode;
  return File;
};

export const processFilePath = (filePath: string | null): string | null => {
  if (!filePath) return null;
  // Trim whitespace, remove escaped newlines, split by actual newlines and take first line
  // Then trim again to ensure no trailing whitespace
  const processed = filePath.trim().replace(/\\n/g, '\n').split('\n')[0].trim();
  return processed || null;
};

export const getFileName = (processedFilePath: string | null): string => {
  if (!processedFilePath) return '';
  const fileName = processedFilePath.split('/').pop() || processedFilePath;
  // Trim whitespace, newlines, and other control characters
  return fileName.trim().replace(/[\r\n]+/g, '').replace(/\s+$/g, '');
};

export const getFileExtension = (fileName: string): string => {
  const trimmed = fileName.trim();
  return trimmed.split('.').pop()?.toLowerCase() || '';
};

export const isFileType = {
  markdown: (fileExtension: string): boolean => fileExtension === 'md',
  html: (fileExtension: string): boolean => fileExtension === 'html' || fileExtension === 'htm',
  csv: (fileExtension: string): boolean => fileExtension === 'csv',
  xlsx: (fileExtension: string): boolean => fileExtension === 'xlsx' || fileExtension === 'xls',
  pptx: (fileExtension: string): boolean => fileExtension === 'pptx' || fileExtension === 'ppt',
};

export const hasLanguageHighlighting = (language: string): boolean => {
  return language !== 'text';
};

export const splitContentIntoLines = (fileContent: string | null): string[] => {
  if (!fileContent || typeof fileContent !== 'string') {
    return [];
  }
  return fileContent.replace(/\\n/g, '\n').split('\n');
};

export function calculateEmptyLinesNeeded(
  contentLinesCount: number,
  containerHeight: number,
  lineHeight: number = 24, // Default line height in pixels
  minEmptyLines: number = 20 // Minimum empty lines to add
): number {
  // Calculate how many lines can fit in the viewport
  const visibleLines = Math.floor(containerHeight / lineHeight);
  
  // If content already fills the viewport, add minimum empty lines
  if (contentLinesCount >= visibleLines) {
    return minEmptyLines;
  }
  
  // Otherwise, calculate how many empty lines needed to fill viewport
  // Add a buffer to ensure smooth scrolling
  const emptyLinesNeeded = visibleLines - contentLinesCount + minEmptyLines;
  
  return Math.max(emptyLinesNeeded, minEmptyLines);
}

export function generateEmptyLines(count: number): string[] {
  return Array.from({ length: count }, () => '');
}