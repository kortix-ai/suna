import { ReactNode } from 'react';

export const FolderIcon = () => (
  <svg viewBox="0 0 64 64" className="w-full h-full">
    <defs>
      <linearGradient id="folderMainBrowser" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor="#60A5FA" />
        <stop offset="100%" stopColor="#3B82F6" />
      </linearGradient>
      <linearGradient id="folderTopBrowser" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor="#93C5FD" />
        <stop offset="100%" stopColor="#60A5FA" />
      </linearGradient>
    </defs>
    <rect x="4" y="18" width="56" height="40" rx="6" fill="url(#folderMainBrowser)"/>
    <path d="M4 24 Q4 18 10 18 L24 18 L28 14 Q30 12 34 12 L54 12 Q60 12 60 18 L60 22 L4 22 Z" fill="url(#folderTopBrowser)"/>
    <rect x="4" y="22" width="56" height="4" fill="rgba(255,255,255,0.15)"/>
  </svg>
);

export const CodeFileIcon = () => (
  <svg viewBox="0 0 64 64" className="w-full h-full">
    <defs>
      <linearGradient id="codeModernBrowser" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#22D3EE" />
        <stop offset="50%" stopColor="#818CF8" />
        <stop offset="100%" stopColor="#C084FC" />
      </linearGradient>
    </defs>
    <rect x="6" y="6" width="52" height="52" rx="12" fill="url(#codeModernBrowser)"/>
    <path d="M22 22 L12 32 L22 42" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
    <path d="M42 22 L52 32 L42 42" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
    <line x1="36" y1="18" x2="28" y2="46" stroke="rgba(255,255,255,0.6)" strokeWidth="3" strokeLinecap="round"/>
  </svg>
);

export const ImageFileIcon = () => (
  <svg viewBox="0 0 64 64" className="w-full h-full">
    <defs>
      <linearGradient id="imgModernBrowser" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#F472B6" />
        <stop offset="50%" stopColor="#A855F7" />
        <stop offset="100%" stopColor="#6366F1" />
      </linearGradient>
    </defs>
    <rect x="6" y="10" width="52" height="44" rx="8" fill="url(#imgModernBrowser)"/>
    <circle cx="22" cy="26" r="7" fill="rgba(255,255,255,0.85)"/>
    <path d="M10 46 L22 32 L32 42 L42 30 L54 46 Q54 52 50 54 L14 54 Q10 54 10 50 Z" fill="rgba(255,255,255,0.25)"/>
  </svg>
);

export const DocumentFileIcon = () => (
  <svg viewBox="0 0 64 64" className="w-full h-full">
    <defs>
      <linearGradient id="docModernBrowser" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor="#F8FAFC" />
        <stop offset="100%" stopColor="#E2E8F0" />
      </linearGradient>
    </defs>
    <rect x="10" y="4" width="44" height="56" rx="6" fill="url(#docModernBrowser)" stroke="#CBD5E1" strokeWidth="1"/>
    <rect x="18" y="16" width="28" height="2.5" rx="1" fill="#64748B"/>
    <rect x="18" y="23" width="22" height="2.5" rx="1" fill="#94A3B8"/>
    <rect x="18" y="30" width="26" height="2.5" rx="1" fill="#94A3B8"/>
    <rect x="18" y="37" width="20" height="2.5" rx="1" fill="#94A3B8"/>
    <rect x="18" y="44" width="24" height="2.5" rx="1" fill="#94A3B8"/>
  </svg>
);

export const GenericFileIcon = () => (
  <svg viewBox="0 0 64 64" className="w-full h-full">
    <defs>
      <linearGradient id="genModernBrowser" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor="#E2E8F0" />
        <stop offset="100%" stopColor="#CBD5E1" />
      </linearGradient>
    </defs>
    <rect x="10" y="4" width="44" height="56" rx="6" fill="url(#genModernBrowser)"/>
    <rect x="18" y="20" width="28" height="3" rx="1.5" fill="#94A3B8"/>
    <rect x="18" y="28" width="22" height="3" rx="1.5" fill="#94A3B8"/>
    <rect x="18" y="36" width="26" height="3" rx="1.5" fill="#94A3B8"/>
    <rect x="18" y="44" width="18" height="3" rx="1.5" fill="#94A3B8"/>
  </svg>
);

export const VideoFileIcon = () => (
  <svg viewBox="0 0 64 64" className="w-full h-full">
    <defs>
      <linearGradient id="videoModern" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#A855F7" />
        <stop offset="100%" stopColor="#7C3AED" />
      </linearGradient>
    </defs>
    <rect x="6" y="10" width="52" height="44" rx="8" fill="url(#videoModern)"/>
    <path d="M26 22 L26 42 L44 32 Z" fill="rgba(255,255,255,0.9)"/>
  </svg>
);

export const AudioFileIcon = () => (
  <svg viewBox="0 0 64 64" className="w-full h-full">
    <defs>
      <linearGradient id="audioModern" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#10B981" />
        <stop offset="100%" stopColor="#059669" />
      </linearGradient>
    </defs>
    <rect x="6" y="6" width="52" height="52" rx="12" fill="url(#audioModern)"/>
    <circle cx="32" cy="32" r="14" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="3"/>
    <circle cx="32" cy="32" r="8" fill="rgba(255,255,255,0.9)"/>
    <rect x="20" y="14" width="3" height="12" rx="1.5" fill="rgba(255,255,255,0.6)"/>
    <rect x="26" y="10" width="3" height="16" rx="1.5" fill="rgba(255,255,255,0.6)"/>
    <rect x="35" y="12" width="3" height="14" rx="1.5" fill="rgba(255,255,255,0.6)"/>
    <rect x="41" y="16" width="3" height="10" rx="1.5" fill="rgba(255,255,255,0.6)"/>
  </svg>
);

export const ArchiveFileIcon = () => (
  <svg viewBox="0 0 64 64" className="w-full h-full">
    <defs>
      <linearGradient id="archiveModern" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor="#FBBF24" />
        <stop offset="100%" stopColor="#F59E0B" />
      </linearGradient>
    </defs>
    <rect x="10" y="4" width="44" height="56" rx="6" fill="url(#archiveModern)"/>
    <rect x="26" y="8" width="12" height="4" rx="1" fill="rgba(0,0,0,0.2)"/>
    <rect x="26" y="14" width="12" height="4" rx="1" fill="rgba(0,0,0,0.2)"/>
    <rect x="26" y="20" width="12" height="4" rx="1" fill="rgba(0,0,0,0.2)"/>
    <rect x="26" y="26" width="12" height="4" rx="1" fill="rgba(0,0,0,0.2)"/>
    <rect x="24" y="34" width="16" height="20" rx="2" fill="rgba(0,0,0,0.15)"/>
    <circle cx="32" cy="40" r="3" fill="rgba(0,0,0,0.3)"/>
  </svg>
);

export const MarkdownFileIcon = () => (
  <svg viewBox="0 0 64 64" className="w-full h-full">
    <defs>
      <linearGradient id="mdModern" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor="#1E293B" />
        <stop offset="100%" stopColor="#0F172A" />
      </linearGradient>
    </defs>
    <rect x="6" y="10" width="52" height="44" rx="6" fill="url(#mdModern)"/>
    <text x="32" y="40" textAnchor="middle" fill="white" fontSize="14" fontWeight="bold" fontFamily="system-ui">MD</text>
  </svg>
);

export const JsonFileIcon = () => (
  <svg viewBox="0 0 64 64" className="w-full h-full">
    <defs>
      <linearGradient id="jsonModern" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#FCD34D" />
        <stop offset="100%" stopColor="#F59E0B" />
      </linearGradient>
    </defs>
    <rect x="6" y="6" width="52" height="52" rx="12" fill="url(#jsonModern)"/>
    <text x="32" y="40" textAnchor="middle" fill="#78350F" fontSize="16" fontWeight="bold" fontFamily="monospace">{ }</text>
  </svg>
);

export const PdfFileIcon = () => (
  <svg viewBox="0 0 64 64" className="w-full h-full">
    <defs>
      <linearGradient id="pdfModern" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor="#EF4444" />
        <stop offset="100%" stopColor="#DC2626" />
      </linearGradient>
    </defs>
    <rect x="10" y="4" width="44" height="56" rx="6" fill="url(#pdfModern)"/>
    <text x="32" y="40" textAnchor="middle" fill="white" fontSize="12" fontWeight="bold" fontFamily="system-ui">PDF</text>
  </svg>
);

export const SpreadsheetFileIcon = () => (
  <svg viewBox="0 0 64 64" className="w-full h-full">
    <defs>
      <linearGradient id="sheetModern" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor="#22C55E" />
        <stop offset="100%" stopColor="#16A34A" />
      </linearGradient>
    </defs>
    <rect x="6" y="6" width="52" height="52" rx="8" fill="url(#sheetModern)"/>
    <rect x="14" y="14" width="36" height="36" rx="2" fill="rgba(255,255,255,0.2)"/>
    <line x1="14" y1="26" x2="50" y2="26" stroke="rgba(255,255,255,0.5)" strokeWidth="1"/>
    <line x1="14" y1="38" x2="50" y2="38" stroke="rgba(255,255,255,0.5)" strokeWidth="1"/>
    <line x1="26" y1="14" x2="26" y2="50" stroke="rgba(255,255,255,0.5)" strokeWidth="1"/>
    <line x1="38" y1="14" x2="38" y2="50" stroke="rgba(255,255,255,0.5)" strokeWidth="1"/>
  </svg>
);

export const ConfigFileIcon = () => (
  <svg viewBox="0 0 64 64" className="w-full h-full">
    <defs>
      <linearGradient id="configModern" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#64748B" />
        <stop offset="100%" stopColor="#475569" />
      </linearGradient>
    </defs>
    <rect x="6" y="6" width="52" height="52" rx="12" fill="url(#configModern)"/>
    <circle cx="32" cy="32" r="12" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="3"/>
    <circle cx="32" cy="32" r="5" fill="rgba(255,255,255,0.8)"/>
    <rect x="30" y="8" width="4" height="10" rx="2" fill="rgba(255,255,255,0.8)"/>
    <rect x="30" y="46" width="4" height="10" rx="2" fill="rgba(255,255,255,0.8)"/>
    <rect x="8" y="30" width="10" height="4" rx="2" fill="rgba(255,255,255,0.8)"/>
    <rect x="46" y="30" width="10" height="4" rx="2" fill="rgba(255,255,255,0.8)"/>
  </svg>
);

export const PresentationFileIcon = () => (
  <svg viewBox="0 0 64 64" className="w-full h-full">
    <defs>
      <linearGradient id="presentModern" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#FB923C" />
        <stop offset="100%" stopColor="#EA580C" />
      </linearGradient>
    </defs>
    <rect x="6" y="10" width="52" height="38" rx="4" fill="url(#presentModern)"/>
    <rect x="10" y="14" width="44" height="30" rx="2" fill="rgba(255,255,255,0.9)"/>
    <rect x="28" y="48" width="8" height="4" fill="url(#presentModern)"/>
    <rect x="22" y="52" width="20" height="4" rx="2" fill="url(#presentModern)"/>
    <rect x="14" y="20" width="20" height="3" rx="1" fill="#FB923C"/>
    <rect x="14" y="26" width="28" height="2" rx="1" fill="#FDBA74"/>
    <rect x="14" y="31" width="24" height="2" rx="1" fill="#FDBA74"/>
    <rect x="14" y="36" width="26" height="2" rx="1" fill="#FDBA74"/>
  </svg>
);

interface FileIconInfo {
  name: string;
  path?: string;
  is_dir?: boolean;
  extension?: string;
}

export function getFileIconByName(fileName: string, isDirectory: boolean = false): ReactNode {
  if (isDirectory) {
    return <FolderIcon />;
  }
  
  const ext = fileName.includes('.') 
    ? fileName.split('.').pop()?.toLowerCase() || ''
    : '';
  
  if (['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'ico', 'bmp', 'tiff'].includes(ext)) {
    return <ImageFileIcon />;
  }
  
  if (['mp4', 'webm', 'mov', 'avi', 'mkv', 'flv', 'wmv'].includes(ext)) {
    return <VideoFileIcon />;
  }
  
  if (['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma'].includes(ext)) {
    return <AudioFileIcon />;
  }
  
  if (['zip', 'tar', 'gz', 'rar', '7z', 'bz2', 'xz', 'tgz'].includes(ext)) {
    return <ArchiveFileIcon />;
  }
  
  if (['md', 'mdx', 'markdown'].includes(ext)) {
    return <MarkdownFileIcon />;
  }
  
  if (['json', 'jsonc', 'json5'].includes(ext)) {
    return <JsonFileIcon />;
  }
  
  if (['pdf'].includes(ext)) {
    return <PdfFileIcon />;
  }
  
  if (['csv', 'xls', 'xlsx', 'ods'].includes(ext)) {
    return <SpreadsheetFileIcon />;
  }
  
  if (['yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties'].includes(ext)) {
    return <ConfigFileIcon />;
  }
  
  if (['js', 'ts', 'jsx', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 
       'css', 'scss', 'sass', 'less', 'html', 'htm', 'vue', 'svelte', 'php', 'swift',
       'kt', 'kts', 'scala', 'clj', 'ex', 'exs', 'erl', 'hs', 'lua', 'r', 'sh', 'bash',
       'zsh', 'fish', 'ps1', 'sql', 'graphql', 'gql'].includes(ext)) {
    return <CodeFileIcon />;
  }
  
  if (['txt', 'log', 'rtf', 'doc', 'docx', 'odt'].includes(ext)) {
    return <DocumentFileIcon />;
  }
  
  // Canvas files
  if (['kanvax'].includes(ext)) {
    return <ImageFileIcon />;
  }
  
  return <GenericFileIcon />;
}

export function getFileIcon(file: FileIconInfo): ReactNode {
  const isDir = file.is_dir ?? false;
  
  if (isDir) {
    return <FolderIcon />;
  }
  
  const ext = file.extension?.toLowerCase() || 
    (file.name?.includes('.') ? file.name.split('.').pop()?.toLowerCase() : '') || '';
  
  return getFileIconByName(file.name || '', false);
}
