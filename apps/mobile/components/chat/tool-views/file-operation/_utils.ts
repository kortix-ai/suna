import { LucideIcon, FilePen, Replace, Trash2, FileCode } from 'lucide-react-native';

type DiffType = 'unchanged' | 'added' | 'removed';

interface LineDiff {
  type: DiffType;
  oldLine: string | null;
  newLine: string | null;
  lineNumber: number;
}

interface DiffStats {
  additions: number;
  deletions: number;
}

const parseNewlines = (text: string): string => {
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

export const calculateDiffStats = (lineDiff: LineDiff[]): DiffStats => {
  return {
    additions: lineDiff.filter(line => line.type === 'added').length,
    deletions: lineDiff.filter(line => line.type === 'removed').length
  };
};

type FileOperation = 'create' | 'rewrite' | 'delete' | 'edit' | 'str-replace' | 'read';

interface OperationConfig {
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

export const getOperationType = (name?: string): FileOperation => {
  if (!name) return 'create';
  
  if (name.includes('create')) return 'create';
  if (name.includes('rewrite')) return 'rewrite';
  if (name.includes('delete')) return 'delete';
  if (name.includes('edit-file')) return 'edit';
  if (name.includes('str-replace')) return 'str-replace';
  if (name.includes('read')) return 'read';
  
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
  read: {
    icon: FileCode,
    color: 'text-indigo-600',
    successMessage: 'File read successfully',
    progressMessage: 'Reading file...',
    bgColor: 'bg-indigo-50',
    gradientBg: 'from-indigo-50 to-indigo-100',
    borderColor: 'border-indigo-200',
    badgeColor: 'bg-indigo-100 text-indigo-700 border-indigo-200',
    hoverColor: 'hover:bg-indigo-100',
  },
  };
};

export const getOperationTitle = (operation: FileOperation): string => {
  const titles: Record<FileOperation, string> = {
    create: 'Create File',
    edit: 'Edit File',
    rewrite: 'Rewrite File',
    delete: 'Delete File',
    'str-replace': 'String Replace',
    read: 'Read File',
  };
  return titles[operation] || 'File Operation';
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
  json: (fileExtension: string): boolean => fileExtension === 'json' || fileExtension === 'jsonc',
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
