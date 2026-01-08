import React, { useState } from 'react';
import {
  AlertTriangle,
  Upload,
  ExternalLink,
  File,
  FileImage,
  FileCode,
  FileText,
  FileJson,
  FileVideo,
  FileAudio,
  FileArchive,
  Copy,
  Check,
  Table,
  CheckCircle2,
} from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { ToolViewProps } from './types';
import { getToolTitle } from './utils';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { ToolViewHeader } from './shared/ToolViewHeader';
import { ToolViewFooter } from './shared/ToolViewFooter';

interface UploadResult {
  message?: string;
  storage_path?: string;
  file_size?: string;
  secure_url?: string;
  expires_at?: string;
  success?: boolean;
  file_id?: string;
}

export function UploadFileToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const [copied, setCopied] = useState(false);

  if (!toolCall) {
    console.warn('UploadFileToolView: toolCall is undefined. Tool views should use structured props.');
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();

  const uploadData = {
    file_path: toolCall.arguments?.file_path || null,
    bucket_name: toolCall.arguments?.bucket_name || 'file-uploads',
    custom_filename: toolCall.arguments?.custom_filename || null,
  };

  let uploadResult: UploadResult | null = null;

  if (toolResult?.output) {
    const output = toolResult.output;
    
    if (typeof output === 'string') {
      uploadResult = {
        message: output,
        success: toolResult?.success !== undefined ? toolResult.success : true,
      };

      const storageMatch = output.match(/📁 Storage: ([^\n]+)/);
      const sizeMatch = output.match(/📏 Size: ([^\n]+)/);
      const urlMatch = output.match(/🔗 Secure Access URL: ([^\n]+)/);
      const expiresMatch = output.match(/⏰ URL expires: ([^\n]+)/);
      const fileIdMatch = output.match(/📋 File ID: ([^\n]+)/);

      if (storageMatch) uploadResult.storage_path = storageMatch[1];
      if (sizeMatch) uploadResult.file_size = sizeMatch[1];
      if (urlMatch) uploadResult.secure_url = urlMatch[1];
      if (expiresMatch) uploadResult.expires_at = expiresMatch[1];
      if (fileIdMatch) uploadResult.file_id = fileIdMatch[1];
    } else if (typeof output === 'object' && output !== null) {
      uploadResult = {
        message: (output as any).message || JSON.stringify(output),
        storage_path: (output as any).storage_path,
        file_size: (output as any).file_size,
        secure_url: (output as any).secure_url,
        expires_at: (output as any).expires_at,
        success: toolResult?.success !== undefined ? toolResult.success : true,
      };
    }
  }

  const toolTitle = getToolTitle(name);
  const actualIsSuccess = uploadResult?.success !== undefined ? uploadResult.success : isSuccess;

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success('Copied to clipboard');
    } catch {
      toast.error('Failed to copy');
    }
  };

  const getFileName = (filePath: string | null) => {
    if (!filePath) return 'Unknown file';
    const fileName = filePath.split('/').pop() || filePath;
    // Trim whitespace, newlines, and other control characters
    return fileName.trim().replace(/[\r\n]+/g, '').replace(/\s+$/g, '') || 'Unknown file';
  };

  const getFileExtension = (filename: string) => {
    const trimmed = filename.trim();
    return trimmed.split('.').pop()?.toLowerCase() || '';
  };

  const getFileIcon = (filename: string) => {
    const ext = getFileExtension(filename);
    
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'ico'].includes(ext)) return FileImage;
    if (['js', 'ts', 'jsx', 'tsx', 'py', 'html', 'css', 'scss', 'vue', 'go', 'rs', 'rb', 'php', 'java', 'c', 'cpp', 'h'].includes(ext)) return FileCode;
    if (['txt', 'md', 'doc', 'docx', 'pdf', 'rtf'].includes(ext)) return FileText;
    if (['csv', 'xlsx', 'xls'].includes(ext)) return Table;
    if (['mp4', 'mov', 'avi', 'webm', 'mkv'].includes(ext)) return FileVideo;
    if (['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'].includes(ext)) return FileAudio;
    if (['zip', 'rar', 'tar', 'gz', '7z', 'bz2'].includes(ext)) return FileArchive;
    if (ext === 'json') return FileJson;
    
    return File;
  };

  const fileName = getFileName(uploadData.file_path);
  const FileIcon = getFileIcon(fileName);
  const fileExt = getFileExtension(fileName).toUpperCase();

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <ToolViewHeader icon={Upload} title={toolTitle} />

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <div className="flex items-center gap-4 p-4">
            <div className="relative">
              <div className="w-12 h-12 rounded-xl bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center">
                <FileIcon className="h-5 w-5 text-zinc-400" />
              </div>
              <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-white dark:bg-zinc-900 flex items-center justify-center shadow-sm border border-zinc-200 dark:border-zinc-700">
                <KortixLoader customSize={12} />
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
                {fileName}
              </p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                Uploading...
              </p>
            </div>
          </div>
        ) : actualIsSuccess && uploadResult ? (
          <div className="h-full flex flex-col p-4">
            <div className="flex items-start gap-4 flex-shrink-0">
              {/* File Icon with Success Badge */}
              <div className="relative flex-shrink-0">
                <div className="w-12 h-12 rounded-xl bg-zinc-50 dark:bg-zinc-900/30 flex items-center justify-center border border-zinc-100 dark:border-zinc-800/50">
                  <FileIcon className="h-5 w-5 text-zinc-600 dark:text-zinc-400" />
                </div>
                <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-zinc-500 flex items-center justify-center shadow-sm">
                  <Check className="h-3 w-3 text-white" />
                </div>
              </div>
              
              {/* File Info */}
              <div className="flex-1 min-w-0 space-y-2">
                <div>
                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
                    {fileName}
                  </p>
                  <div className="flex items-center gap-2 mt-1">
                    {fileExt && (
                      <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400">
                        {fileExt}
                      </Badge>
                    )}
                    {uploadResult.file_size && (
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">
                        {uploadResult.file_size}
                      </span>
                    )}
                  </div>
                </div>
                
                {/* URL Actions */}
                {uploadResult.secure_url && (
                  <div className="flex items-center gap-2 pt-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => window.open(uploadResult.secure_url!, '_blank')}
                      className="h-8 text-xs"
                    >
                      <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                      Open
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => copyToClipboard(uploadResult.secure_url!)}
                      className={cn(
                        "h-8 text-xs transition-colors",
                        copied && "text-zinc-600 dark:text-zinc-400"
                      )}
                    >
                      {copied ? (
                        <>
                          <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
                          Copied
                        </>
                      ) : (
                        <>
                          <Copy className="h-3.5 w-3.5 mr-1.5" />
                          Copy URL
                        </>
                      )}
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-4 p-4">
            <div className="relative flex-shrink-0">
              <div className="w-12 h-12 rounded-xl bg-red-50 dark:bg-red-950/30 flex items-center justify-center border border-red-100 dark:border-red-900/50">
                <AlertTriangle className="h-5 w-5 text-red-500 dark:text-red-400" />
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                Upload failed
              </p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 line-clamp-2">
                {uploadResult?.message || 'The file upload encountered an error.'}
              </p>
            </div>
          </div>
        )}
      </CardContent>

      <ToolViewFooter
        assistantTimestamp={assistantTimestamp}
        toolTimestamp={toolTimestamp}
        isStreaming={isStreaming}
      />
    </Card>
  );
}
