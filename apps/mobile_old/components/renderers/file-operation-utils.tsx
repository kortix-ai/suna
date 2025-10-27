import { Ionicons } from '@expo/vector-icons';

export interface FileOperation {
    type: 'create' | 'read' | 'update' | 'delete';
    filePath: string;
    content?: string;
}

export interface OperationConfig {
    icon: keyof typeof Ionicons.glyphMap;
    color: string;
    bgColor: string;
    borderColor: string;
    gradientBg: string;
    hoverColor: string;
    progressMessage: string;
}

export function getOperationType(toolName?: string, content?: string): 'create' | 'read' | 'update' | 'delete' {
    if (!toolName) return 'read';

    const name = toolName.toLowerCase();

    if (name.includes('create') || name.includes('write')) {
        return 'create';
    } else if (name.includes('delete') || name.includes('remove')) {
        return 'delete';
    } else if (name.includes('update') || name.includes('edit') || name.includes('modify')) {
        return 'update';
    }

    return 'read';
}

export function getOperationConfigs(): Record<string, OperationConfig> {
    return {
        create: {
            icon: 'document-text',
            color: '#10b981',
            bgColor: '#dcfce7',
            borderColor: '#bbf7d0',
            gradientBg: '#f0fdf4',
            hoverColor: '#f0fdf4',
            progressMessage: 'Creating file...'
        },
        read: {
            icon: 'eye',
            color: '#3b82f6',
            bgColor: '#dbeafe',
            borderColor: '#bfdbfe',
            gradientBg: '#eff6ff',
            hoverColor: '#eff6ff',
            progressMessage: 'Reading file...'
        },
        update: {
            icon: 'pencil',
            color: '#f59e0b',
            bgColor: '#fef3c7',
            borderColor: '#fde68a',
            gradientBg: '#fffbeb',
            hoverColor: '#fffbeb',
            progressMessage: 'Updating file...'
        },
        delete: {
            icon: 'trash',
            color: '#ef4444',
            bgColor: '#fee2e2',
            borderColor: '#fecaca',
            gradientBg: '#fef2f2',
            hoverColor: '#fef2f2',
            progressMessage: 'Deleting file...'
        }
    };
}

export function getLanguageFromFileName(fileName: string): string {
    if (!fileName) return 'text';

    const extension = fileName.split('.').pop()?.toLowerCase();

    const languageMap: { [key: string]: string } = {
        'js': 'javascript',
        'jsx': 'javascript',
        'ts': 'typescript',
        'tsx': 'typescript',
        'py': 'python',
        'java': 'java',
        'c': 'c',
        'cpp': 'cpp',
        'cc': 'cpp',
        'cxx': 'cpp',
        'cs': 'csharp',
        'go': 'go',
        'rs': 'rust',
        'php': 'php',
        'rb': 'ruby',
        'swift': 'swift',
        'kt': 'kotlin',
        'html': 'html',
        'htm': 'html',
        'css': 'css',
        'scss': 'scss',
        'sass': 'sass',
        'less': 'less',
        'json': 'json',
        'xml': 'xml',
        'md': 'markdown',
        'markdown': 'markdown',
        'sql': 'sql',
        'sh': 'shell',
        'bash': 'bash',
        'zsh': 'shell',
        'fish': 'shell',
        'yml': 'yaml',
        'yaml': 'yaml',
        'toml': 'toml',
        'ini': 'ini',
        'conf': 'config',
        'config': 'config',
        'dockerfile': 'dockerfile',
        'makefile': 'makefile',
        'make': 'makefile',
        'r': 'r',
        'rmd': 'r',
        'scala': 'scala',
        'clj': 'clojure',
        'cljs': 'clojure',
        'hs': 'haskell',
        'elm': 'elm',
        'dart': 'dart',
        'vue': 'vue',
        'svelte': 'svelte',
        'astro': 'astro',
        'tex': 'latex',
        'latex': 'latex',
        'bib': 'bibtex',
        'proto': 'protobuf',
        'graphql': 'graphql',
        'gql': 'graphql',
        'prettierrc': 'json',
        'eslintrc': 'json',
        'tsconfig': 'json',
        'babelrc': 'json',
        'package': 'json',
        'lock': 'json',
        'env': 'env',
        'properties': 'properties',
        'cfg': 'config',
        'log': 'log',
        'txt': 'text',
        'text': 'text',
        'rtf': 'rtf',
        'csv': 'csv',
        'tsv': 'csv',
        'psv': 'csv',
        'dsv': 'csv',
    };

    return languageMap[extension || ''] || 'text';
}

export function getFileIcon(fileName: string): keyof typeof Ionicons.glyphMap {
    if (!fileName) return 'document-text';

    const extension = fileName.split('.').pop()?.toLowerCase();

    const iconMap: { [key: string]: keyof typeof Ionicons.glyphMap } = {
        // Code files
        'js': 'logo-javascript',
        'jsx': 'logo-javascript',
        'ts': 'logo-javascript',
        'tsx': 'logo-javascript',
        'py': 'logo-python',
        'java': 'code-slash',
        'html': 'logo-html5',
        'htm': 'logo-html5',
        'css': 'logo-css3',
        'scss': 'logo-sass',
        'sass': 'logo-sass',
        'less': 'logo-sass',
        'json': 'document-text',
        'xml': 'document-text',
        'md': 'document-text',
        'markdown': 'document-text',
        'sql': 'server',
        'sh': 'terminal',
        'bash': 'terminal',
        'zsh': 'terminal',
        'fish': 'terminal',
        'yml': 'document-text',
        'yaml': 'document-text',
        'toml': 'document-text',
        'ini': 'document-text',
        'conf': 'settings',
        'config': 'settings',
        'dockerfile': 'logo-docker',
        'makefile': 'build',
        'make': 'build',
        'r': 'stats-chart',
        'rmd': 'stats-chart',
        'go': 'code-slash',
        'rs': 'code-slash',
        'php': 'code-slash',
        'rb': 'code-slash',
        'swift': 'code-slash',
        'kt': 'code-slash',
        'dart': 'code-slash',
        'vue': 'logo-vue',
        'svelte': 'code-slash',
        'c': 'code',
        'cpp': 'code',
        'cc': 'code',
        'cxx': 'code',
        'cs': 'code',
        'scala': 'code',
        'clj': 'code',
        'cljs': 'code',
        'hs': 'code',
        'elm': 'code',
        'astro': 'code',
        'tex': 'document-text',
        'latex': 'document-text',
        'bib': 'document-text',
        'proto': 'document-text',
        'graphql': 'document-text',
        'gql': 'document-text',

        // Data files
        'csv': 'grid',
        'tsv': 'grid',
        'psv': 'grid',
        'dsv': 'grid',
        'xls': 'grid',
        'xlsx': 'grid',
        'ods': 'grid',

        // Image files
        'png': 'image',
        'jpg': 'image',
        'jpeg': 'image',
        'gif': 'image',
        'bmp': 'image',
        'tiff': 'image',
        'tif': 'image',
        'svg': 'image',
        'webp': 'image',
        'ico': 'image',

        // Video files
        'mp4': 'videocam',
        'avi': 'videocam',
        'mov': 'videocam',
        'wmv': 'videocam',
        'flv': 'videocam',
        'webm': 'videocam',
        'mkv': 'videocam',
        '3gp': 'videocam',

        // Audio files
        'mp3': 'musical-notes',
        'wav': 'musical-notes',
        'flac': 'musical-notes',
        'ogg': 'musical-notes',
        'aac': 'musical-notes',
        'wma': 'musical-notes',
        'm4a': 'musical-notes',

        // Archive files
        'zip': 'archive',
        'rar': 'archive',
        '7z': 'archive',
        'tar': 'archive',
        'gz': 'archive',
        'bz2': 'archive',
        'xz': 'archive',

        // Document files
        'pdf': 'document-text',
        'doc': 'document-text',
        'docx': 'document-text',
        'odt': 'document-text',
        'rtf': 'document-text',
        'txt': 'document-text',
        'text': 'document-text',

        // Other files
        'log': 'document-text',
        'env': 'key',
        'properties': 'settings',
        'cfg': 'settings',
        'gitignore': 'git-branch',
        'gitattributes': 'git-branch',
        'editorconfig': 'settings',
        'prettierrc': 'settings',
        'eslintrc': 'settings',
        'tsconfig': 'settings',
        'babelrc': 'settings',
        'package': 'library',
        'lock': 'lock-closed',
    };

    return iconMap[extension || ''] || 'document-text';
}

export function processFilePath(filePath: string | null): string {
    if (!filePath) return '';

    // Remove common prefixes and normalize path
    return filePath.replace(/^\.\//, '').replace(/^\//, '');
}

export function getFileName(filePath: string): string {
    if (!filePath) return '';

    const parts = filePath.split('/');
    return parts[parts.length - 1] || '';
}

export function getFileExtension(fileName: string): string {
    if (!fileName) return '';

    const parts = fileName.split('.');
    return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
}

export const isFileType = {
    markdown: (ext: string) => ['md', 'markdown', 'mdown', 'mkd'].includes(ext.toLowerCase()),
    html: (ext: string) => ['html', 'htm', 'xhtml'].includes(ext.toLowerCase()),
    csv: (ext: string) => ['csv', 'tsv', 'psv', 'dsv'].includes(ext.toLowerCase()),
    image: (ext: string) => ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'tiff', 'tif', 'svg', 'webp', 'ico'].includes(ext.toLowerCase()),
    video: (ext: string) => ['mp4', 'avi', 'mov', 'wmv', 'flv', 'webm', 'mkv', '3gp'].includes(ext.toLowerCase()),
    audio: (ext: string) => ['mp3', 'wav', 'flac', 'ogg', 'aac', 'wma', 'm4a'].includes(ext.toLowerCase()),
    archive: (ext: string) => ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'].includes(ext.toLowerCase()),
    document: (ext: string) => ['pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'text'].includes(ext.toLowerCase()),
    code: (ext: string) => [
        'js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'cpp', 'cc', 'cxx', 'cs',
        'go', 'rs', 'php', 'rb', 'swift', 'kt', 'dart', 'vue', 'svelte',
        'scala', 'clj', 'cljs', 'hs', 'elm', 'astro'
    ].includes(ext.toLowerCase()),
    data: (ext: string) => ['json', 'xml', 'yml', 'yaml', 'toml', 'ini', 'conf', 'config'].includes(ext.toLowerCase()),
};

export function hasLanguageHighlighting(language: string): boolean {
    const supportedLanguages = [
        'javascript', 'typescript', 'python', 'java', 'c', 'cpp', 'csharp',
        'go', 'rust', 'php', 'ruby', 'swift', 'kotlin', 'html', 'css', 'scss',
        'sass', 'less', 'json', 'xml', 'markdown', 'sql', 'shell', 'bash',
        'yaml', 'toml', 'dockerfile', 'makefile', 'r', 'scala', 'clojure',
        'haskell', 'elm', 'dart', 'vue', 'svelte', 'astro', 'latex', 'protobuf',
        'graphql'
    ];

    return supportedLanguages.includes(language.toLowerCase());
}

export function splitContentIntoLines(content: string | null): string[] {
    if (!content) return [];
    return content.split('\n');
}

export function extractFilePath(content: string): string | null {
    if (!content) return null;

    // Try to extract file path from various patterns
    const patterns = [
        /(?:file|path|File|Path):\s*['"]?([^'">\s]+)['"]?/i,
        /(?:writing|creating|updating|deleting)\s+(?:file\s+)?['"]?([^'">\s]+)['"]?/i,
        /['"]?([^'">\s]+\.[a-zA-Z0-9]{1,4})['"]?/,
    ];

    for (const pattern of patterns) {
        const match = content.match(pattern);
        if (match && match[1]) {
            return match[1];
        }
    }

    return null;
}

export function extractFileContent(content: string, operation: string): string | null {
    if (!content) return null;

    // Try to extract file content from various patterns
    const patterns = [
        /```(?:[a-zA-Z0-9]*\n)?([\s\S]*?)```/,
        /(?:content|Content):\s*\n([\s\S]*?)(?:\n\n|\n$|$)/,
        /(?:file content|File content):\s*\n([\s\S]*?)(?:\n\n|\n$|$)/,
    ];

    for (const pattern of patterns) {
        const match = content.match(pattern);
        if (match && match[1]) {
            return match[1].trim();
        }
    }

    return null;
}

export function extractStreamingFileContent(content: string, operation: string): string | null {
    // For streaming content, we might get partial content
    return extractFileContent(content, operation);
}

export function extractToolData(content: string): { toolResult: boolean; filePath: string | null; fileContent: string | null } {
    if (!content) return { toolResult: false, filePath: null, fileContent: null };

    return {
        toolResult: true,
        filePath: extractFilePath(content),
        fileContent: extractFileContent(content, 'generic')
    };
}

export function formatTimestamp(timestamp: string): string {
    if (!timestamp) return '';

    try {
        const date = new Date(timestamp);
        return date.toLocaleString();
    } catch (error) {
        return timestamp;
    }
}

export function getToolTitle(toolName: string): string {
    if (!toolName) return 'File Operation';

    const titleMap: { [key: string]: string } = {
        'file-create': 'Create File',
        'file-read': 'Read File',
        'file-update': 'Update File',
        'file-delete': 'Delete File',
        'file-write': 'Write File',
        'file-edit': 'Edit File',
        'file-modify': 'Modify File',
        'file-remove': 'Remove File',
    };

    return titleMap[toolName.toLowerCase()] || toolName.replace(/[-_]/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
}

export function normalizeContentToString(content: any): string {
    if (typeof content === 'string') return content;
    if (content === null || content === undefined) return '';
    if (typeof content === 'object') {
        try {
            return JSON.stringify(content, null, 2);
        } catch {
            return String(content);
        }
    }
    return String(content);
}

export function processUnicodeContent(content: string): string {
    if (!content) return '';

    // Handle common unicode characters and escape sequences
    return content
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\r/g, '\r')
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'")
        .replace(/\\\\/g, '\\');
} 