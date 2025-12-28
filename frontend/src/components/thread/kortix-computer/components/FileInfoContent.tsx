'use client';

import { memo, useState } from 'react';
import { Folder, File, Calendar, MapPin, Copy, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getFileIconByName } from './Icons';
import { toast } from 'sonner';

export interface FileInfo {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  modTime?: string;
  extension?: string;
}

interface FileInfoContentProps {
  fileInfo: FileInfo;
}

const formatDate = (dateStr?: string): string => {
  if (!dateStr) return 'Unknown';
  
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
};

const getFileType = (name: string, isDirectory: boolean): string => {
  if (isDirectory) return 'Folder';
  
  const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() : null;
  if (!ext) return 'File';
  
  const typeMap: Record<string, string> = {
    'js': 'JavaScript File',
    'jsx': 'React JSX File',
    'ts': 'TypeScript File',
    'tsx': 'React TSX File',
    'py': 'Python File',
    'rb': 'Ruby File',
    'go': 'Go File',
    'rs': 'Rust File',
    'java': 'Java File',
    'c': 'C Source File',
    'cpp': 'C++ Source File',
    'h': 'C Header File',
    'hpp': 'C++ Header File',
    'css': 'CSS Stylesheet',
    'scss': 'SCSS Stylesheet',
    'sass': 'Sass Stylesheet',
    'less': 'Less Stylesheet',
    'html': 'HTML Document',
    'htm': 'HTML Document',
    'xml': 'XML Document',
    'json': 'JSON File',
    'yaml': 'YAML File',
    'yml': 'YAML File',
    'md': 'Markdown Document',
    'txt': 'Text File',
    'pdf': 'PDF Document',
    'doc': 'Word Document',
    'docx': 'Word Document',
    'xls': 'Excel Spreadsheet',
    'xlsx': 'Excel Spreadsheet',
    'ppt': 'PowerPoint Presentation',
    'pptx': 'PowerPoint Presentation',
    'png': 'PNG Image',
    'jpg': 'JPEG Image',
    'jpeg': 'JPEG Image',
    'gif': 'GIF Image',
    'svg': 'SVG Image',
    'webp': 'WebP Image',
    'ico': 'Icon File',
    'mp3': 'MP3 Audio',
    'wav': 'WAV Audio',
    'mp4': 'MP4 Video',
    'mov': 'QuickTime Video',
    'avi': 'AVI Video',
    'webm': 'WebM Video',
    'zip': 'ZIP Archive',
    'tar': 'TAR Archive',
    'gz': 'GZIP Archive',
    'rar': 'RAR Archive',
    '7z': '7-Zip Archive',
    'sh': 'Shell Script',
    'bash': 'Bash Script',
    'zsh': 'Zsh Script',
    'sql': 'SQL File',
    'env': 'Environment File',
    'gitignore': 'Git Ignore File',
    'dockerfile': 'Dockerfile',
    'lock': 'Lock File',
    'kanvax': 'Kortix Canvas',
  };
  
  return typeMap[ext] || `${ext.toUpperCase()} File`;
};

export const FileInfoContent = memo(function FileInfoContent({
  fileInfo,
}: FileInfoContentProps) {
  const [copiedPath, setCopiedPath] = useState(false);
  
  const handleCopyPath = () => {
    navigator.clipboard.writeText(fileInfo.path);
    setCopiedPath(true);
    toast.success('Path copied to clipboard');
    setTimeout(() => setCopiedPath(false), 2000);
  };

  const fileType = getFileType(fileInfo.name, fileInfo.isDirectory);

  return (
    <div className="h-full overflow-auto p-6">
      <div className="flex flex-col items-center justify-center gap-4 mb-8">
        <div className="w-24 h-24 flex items-center justify-center">
          {getFileIconByName(fileInfo.name, fileInfo.isDirectory)}
        </div>
        <div className="flex flex-col items-center justify-center text-center">
          <h3 className="text-foreground font-semibold text-xl break-all px-2">{fileInfo.name}</h3>
          <span className="text-sm text-muted-foreground mt-1">{fileType}</span>
        </div>
      </div>

      <div className="bg-muted/50 rounded-xl p-4 border border-border">
        <div className="space-y-3">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center shrink-0">
              {fileInfo.isDirectory ? (
                <Folder className="w-4 h-4 text-white" />
              ) : (
                <File className="w-4 h-4 text-white" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <span className="text-sm text-foreground font-medium">{fileType}</span>
            </div>
          </div>
          
          {fileInfo.modTime && (
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-500 to-purple-600 flex items-center justify-center shrink-0">
                <Calendar className="w-4 h-4 text-white" />
              </div>
              <div className="min-w-0 flex-1">
                <span className="text-sm text-foreground font-medium">{formatDate(fileInfo.modTime)}</span>
              </div>
            </div>
          )}

          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center shrink-0">
              <MapPin className="w-4 h-4 text-white" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm text-foreground font-medium break-all">{fileInfo.path}</span>
                <button
                  onClick={handleCopyPath}
                  className={cn(
                    "shrink-0 p-1.5 rounded-md transition-colors",
                    copiedPath ? "bg-emerald-500/20 text-emerald-500" : "hover:bg-muted text-muted-foreground"
                  )}
                >
                  {copiedPath ? (
                    <Check className="w-3.5 h-3.5" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

FileInfoContent.displayName = 'FileInfoContent';
