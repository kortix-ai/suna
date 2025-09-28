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
  assistantContent: any,
  toolContent: any,
  isSuccess: boolean,
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

  const extractData = (content: any) => {
    let parsed = typeof content === 'string' ? parseContent(content) : content;
    
    // Handle nested content structures like { role: '...', content: '...' }
    if (parsed?.role && parsed?.content) {
        parsed = typeof parsed.content === 'string' ? parseContent(parsed.content) : parsed.content;
    }

    if (parsed?.tool_execution) {
      const args = parsed.tool_execution.arguments || {};
      const output = parseOutput(parsed.tool_execution.result?.output);
      const success = parsed.tool_execution.result?.success;
      
      let errorMessage: string | undefined;
      if (success === false) {
        if (typeof output === 'object' && output !== null && output.message) {
          errorMessage = output.message;
        } else if (typeof output === 'string') {
          errorMessage = output;
        } else {
          errorMessage = JSON.stringify(output);
        }
      }

      return {
        filePath: args.target_file || (typeof output === 'object' && output?.file_path) || null,
        originalContent: (typeof output === 'object' && output?.original_content) ?? null,
        updatedContent: (typeof output === 'object' && output?.updated_content) ?? null,
        success: success,
        timestamp: parsed.tool_execution.execution_details?.timestamp,
        errorMessage: errorMessage,
      };
    }
    
    // Fallback for when toolContent is just the output object from the tool result
    if (typeof parsed === 'object' && parsed !== null && (parsed.original_content !== undefined || parsed.updated_content !== undefined)) {
        return {
            filePath: parsed.file_path || null,
            originalContent: parsed.original_content ?? null,
            updatedContent: parsed.updated_content ?? null,
            success: parsed.updated_content !== null, // Success is false if updated_content is null
            timestamp: null,
            errorMessage: parsed.message,
        };
    }
    return {};
  };

  const toolData = extractData(toolContent);
  const assistantData = extractData(assistantContent);

  const filePath = toolData.filePath || assistantData.filePath;
  const originalContent = toolData.originalContent || assistantData.originalContent;
  const updatedContent = toolData.updatedContent || assistantData.updatedContent;
  const errorMessage = toolData.errorMessage || assistantData.errorMessage;

  let actualIsSuccess = isSuccess;
  let actualToolTimestamp = toolTimestamp;
  let actualAssistantTimestamp = assistantTimestamp;

  if (toolData.success !== undefined) {
    actualIsSuccess = toolData.success;
    actualToolTimestamp = toolData.timestamp || toolTimestamp;
  } else if (assistantData.success !== undefined) {
    actualIsSuccess = assistantData.success;
    actualAssistantTimestamp = assistantData.timestamp || assistantTimestamp;
  }

  return { filePath, originalContent, updatedContent, actualIsSuccess, actualToolTimestamp, actualAssistantTimestamp, errorMessage };
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
      color: 'text-green-600',
    successMessage: 'File created successfully',
    progressMessage: 'Creating file...',
      bgColor: 'bg-green-50',
      gradientBg: 'from-green-50 to-green-100',
      borderColor: 'border-green-200',
      badgeColor: 'bg-green-100 text-green-700 border-green-200',
      hoverColor: 'hover:bg-green-100',
    },
    edit: {
      icon: Replace,
      color: 'text-blue-600',
      successMessage: 'File edited successfully',
      progressMessage: 'Editing file...',
      bgColor: 'bg-blue-50',
      gradientBg: 'from-blue-50 to-blue-100',
      borderColor: 'border-blue-200',
      badgeColor: 'bg-blue-100 text-blue-700 border-blue-200',
      hoverColor: 'hover:bg-blue-100',
  },
  rewrite: {
    icon: Replace,
      color: 'text-amber-600',
    successMessage: 'File rewritten successfully',
    progressMessage: 'Rewriting file...',
      bgColor: 'bg-amber-50',
      gradientBg: 'from-amber-50 to-amber-100',
      borderColor: 'border-amber-200',
      badgeColor: 'bg-amber-100 text-amber-700 border-amber-200',
      hoverColor: 'hover:bg-amber-100',
  },
  delete: {
    icon: Trash2,
      color: 'text-red-600',
    successMessage: 'File deleted successfully',
    progressMessage: 'Deleting file...',
      bgColor: 'bg-red-50',
      gradientBg: 'from-red-50 to-red-100',
      borderColor: 'border-red-200',
      badgeColor: 'bg-red-100 text-red-700 border-red-200',
      hoverColor: 'hover:bg-red-100',
  },
  'str-replace': {
    icon: Replace,
    color: 'text-blue-600',
    successMessage: 'String replaced successfully',
    progressMessage: 'Replacing string...',
    bgColor: 'bg-blue-50',
    gradientBg: 'from-blue-50 to-blue-100',
    borderColor: 'border-blue-200',
    badgeColor: 'bg-blue-100 text-blue-700 border-blue-200',
    hoverColor: 'hover:bg-blue-100',
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
  return filePath
    ? filePath.trim().replace(/\\n/g, '\n').split('\n')[0]
    : null;
};

export const getFileName = (processedFilePath: string | null): string => {
  return processedFilePath
    ? processedFilePath.split('/').pop() || processedFilePath
    : '';
};

export const getFileExtension = (fileName: string): string => {
  return fileName.split('.').pop()?.toLowerCase() || '';
};

export const isFileType = {
  markdown: (fileExtension: string): boolean => fileExtension === 'md',
  html: (fileExtension: string): boolean => fileExtension === 'html' || fileExtension === 'htm',
  csv: (fileExtension: string): boolean => fileExtension === 'csv',
  xlsx: (fileExtension: string): boolean => fileExtension === 'xlsx' || fileExtension === 'xls',
};

export const hasLanguageHighlighting = (language: string): boolean => {
  return language !== 'text';
};

export const splitContentIntoLines = (fileContent: string | null): string[] => {
  return fileContent
    ? fileContent.replace(/\\n/g, '\n').split('\n')
    : [];
};