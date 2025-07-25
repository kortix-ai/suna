import { LucideIcon, FilePen, Replace, Trash2, FileCode, FileSpreadsheet, File } from 'lucide-react';

export type FileOperation = 'create' | 'rewrite' | 'delete' | 'edit';

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

export const getOperationType = (name?: string, assistantContent?: any): FileOperation => {
  if (name) {
    if (name.includes('create')) return 'create';
    if (name.includes('rewrite')) return 'rewrite';
    if (name.includes('delete')) return 'delete';
    if (name.includes('edit')) return 'edit';
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
};

export const hasLanguageHighlighting = (language: string): boolean => {
  return language !== 'text';
};

export const splitContentIntoLines = (fileContent: string | null): string[] => {
  return fileContent
    ? fileContent.replace(/\\n/g, '\n').split('\n')
    : [];
};