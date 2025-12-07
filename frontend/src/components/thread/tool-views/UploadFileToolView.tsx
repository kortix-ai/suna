import React, { useState } from 'react';
import {
  CheckCircle,
  AlertTriangle,
  Upload,
  ExternalLink,
  Clock,
  Shield,
  File,
  FileImage,
  FileCode,
  FileText,
  FileJson,
  FileVideo,
  FileAudio,
  FileArchive,
  FolderOpen,
  Copy,
  Check,
  Lock,
  Database,
  Table,
} from 'lucide-react';
import { ToolViewProps } from './types';
import { formatTimestamp, getToolTitle } from './utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from "@/components/ui/scroll-area";
import { LoadingState } from './shared/LoadingState';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

interface UploadResult {
  message?: string;
  storage_path?: string;
  file_size?: string;
  secure_url?: string;
  expires_at?: string;
  success?: boolean;
}

export function UploadFileToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  // All hooks must be called unconditionally at the top
  const [isCopyingUrl, setIsCopyingUrl] = useState(false);
  const [isCopyingPath, setIsCopyingPath] = useState(false);

  // Defensive check - handle cases where toolCall might be undefined
  if (!toolCall) {
    console.warn('UploadFileToolView: toolCall is undefined. Tool views should use structured props.');
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();

  // Extract data directly from structured props
  const uploadData = {
    file_path: toolCall.arguments?.file_path || null,
    bucket_name: toolCall.arguments?.bucket_name || 'file-uploads',
    custom_filename: toolCall.arguments?.custom_filename || null,
  };

  // Extract result from toolResult
  let uploadResult: UploadResult | null = null;
  let rawContent: string | null = null;

  if (toolResult?.output) {
    const output = toolResult.output;
    
    if (typeof output === 'string') {
      rawContent = output;
      uploadResult = {
        message: output,
        success: toolResult.success !== undefined ? toolResult.success : true,
      };

      // Extract structured data from the output message
      const storageMatch = output.match(/📁 Storage: ([^\n]+)/);
      const sizeMatch = output.match(/📏 Size: ([^\n]+)/);
      const urlMatch = output.match(/🔗 Secure Access URL: ([^\n]+)/);
      const expiresMatch = output.match(/⏰ URL expires: ([^\n]+)/);

      if (storageMatch) uploadResult.storage_path = storageMatch[1];
      if (sizeMatch) uploadResult.file_size = sizeMatch[1];
      if (urlMatch) uploadResult.secure_url = urlMatch[1];
      if (expiresMatch) uploadResult.expires_at = expiresMatch[1];
    } else if (typeof output === 'object' && output !== null) {
      uploadResult = {
        message: (output as any).message || JSON.stringify(output),
        storage_path: (output as any).storage_path,
        file_size: (output as any).file_size,
        secure_url: (output as any).secure_url || (output as any).secure_url,
        expires_at: (output as any).expires_at,
        success: toolResult.success !== undefined ? toolResult.success : true,
      };
    }
  }

  const toolTitle = getToolTitle(name);
  const actualIsSuccess = uploadResult?.success !== undefined ? uploadResult.success : isSuccess;

  const copyToClipboard = async (text: string, type: 'url' | 'path') => {
    try {
      await navigator.clipboard.writeText(text);
      
      if (type === 'url') {
        setIsCopyingUrl(true);
        setTimeout(() => setIsCopyingUrl(false), 2000);
      } else {
        setIsCopyingPath(true);
        setTimeout(() => setIsCopyingPath(false), 2000);
      }
      
      toast.success(`${type === 'url' ? 'Secure URL' : 'Storage path'} copied to clipboard!`);
    } catch (err) {
      toast.error('Failed to copy to clipboard');
    }
  };

  const getFileName = (filePath: string | null) => {
    if (!filePath) return 'Unknown file';
    return filePath.split('/').pop() || filePath;
  };

  const getFileExtension = (filename: string) => {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    return ext;
  };

  const getFileIcon = (filename: string) => {
    const ext = getFileExtension(filename);
    
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext)) return FileImage;
    if (['js', 'ts', 'jsx', 'tsx', 'py', 'html', 'css', 'json'].includes(ext)) return FileCode;
    if (['txt', 'md', 'doc', 'docx', 'pdf'].includes(ext)) return FileText;
    if (['csv', 'xlsx', 'xls'].includes(ext)) return Table;
    if (['mp4', 'mov', 'avi', 'webm'].includes(ext)) return FileVideo;
    if (['mp3', 'wav', 'ogg', 'flac'].includes(ext)) return FileAudio;
    if (['zip', 'rar', 'tar', 'gz'].includes(ext)) return FileArchive;
    if (ext === 'json') return FileJson;
    
    return File;
  };

  const formatFileSize = (sizeStr: string | undefined) => {
    if (!sizeStr) return 'Unknown size';
    return sizeStr;
  };

  const formatExpiryTime = (expiryStr: string | undefined) => {
    if (!expiryStr) return 'Unknown expiry';
    try {
      const date = new Date(expiryStr);
      const now = new Date();
      const diffHours = Math.round((date.getTime() - now.getTime()) / (1000 * 60 * 60));
      return `${expiryStr} (${diffHours}h remaining)`;
    } catch {
      return expiryStr;
    }
  };

  const fileName = getFileName(uploadData.file_path);
  const FileIcon = getFileIcon(fileName);

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-lg bg-gradient-to-br from-emerald-500/20 to-emerald-600/10 border border-emerald-500/20">
              <Upload className="w-5 h-5 text-emerald-500 dark:text-emerald-400" />
            </div>
            <div>
              <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                {toolTitle}
              </CardTitle>
            </div>
          </div>

          {!isStreaming && (
            <Badge
              variant="secondary"
              className={
                actualIsSuccess
                  ? "bg-gradient-to-b from-emerald-200 to-emerald-100 text-emerald-700 dark:from-emerald-800/50 dark:to-emerald-900/60 dark:text-emerald-300"
                  : "bg-gradient-to-b from-rose-200 to-rose-100 text-rose-700 dark:from-rose-800/50 dark:to-rose-900/60 dark:text-rose-300"
              }
            >
              {actualIsSuccess ? (
                <CheckCircle className="h-3.5 w-3.5 mr-1" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5 mr-1" />
              )}
              {actualIsSuccess ? 'Upload successful' : 'Upload failed'}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <LoadingState
            icon={Upload}
            iconColor="text-emerald-500 dark:text-emerald-400"
            bgColor="bg-gradient-to-b from-emerald-100 to-emerald-50 shadow-inner dark:from-emerald-800/40 dark:to-emerald-900/60 dark:shadow-emerald-950/20"
            title="Uploading File"
            filePath={uploadData.file_path || 'Preparing upload...'}
            showProgress={true}
            progressText="Uploading to secure storage..."
          />
        ) : (
          <ScrollArea className="h-full w-full">
            <div className="p-4">
              {actualIsSuccess && uploadResult ? (
                <div className="space-y-4">
                  <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-sm">
                    <div className="p-3">
                      <div className="grid grid-cols-2 gap-3 text-sm">
                        <div className="flex items-center gap-2">
                          <Database className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                          <span className="text-zinc-700 dark:text-zinc-300">
                            {uploadData.bucket_name || 'file-uploads'}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <File className="h-4 w-4 text-purple-600 dark:text-purple-400" />
                          <span className="text-zinc-700 dark:text-zinc-300">
                            {formatFileSize(uploadResult.file_size)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                  {uploadResult.secure_url && (
                    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-sm">
                      <div className="p-3">
                        <div className="flex items-center gap-2 mb-2">
                          <div className="w-6 h-6 rounded bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
                            <ExternalLink className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                          </div>
                          <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                            Secure Access URL
                          </span>
                          <Badge variant="outline" className="text-xs h-5 px-1.5 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800">
                            Private
                          </Badge>
                        </div>

                        <div className="bg-zinc-50 dark:bg-zinc-800 rounded p-2 mb-3">
                          <code className="text-xs font-mono text-zinc-700 dark:text-zinc-300 break-all">
                            {uploadResult.secure_url}
                          </code>
                        </div>

                        <div className="flex items-center justify-between mb-3">
                          <span className="text-xs text-zinc-500 dark:text-zinc-400">
                            🔐 Private
                          </span>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => copyToClipboard(uploadResult.secure_url!, 'url')}
                            className="h-6 px-2 text-xs"
                          >
                            {isCopyingUrl ? (
                              <Check className="h-3 w-3 text-emerald-600" />
                            ) : (
                              <Copy className="h-3 w-3" />
                            )}
                            <span>{isCopyingUrl ? 'Copied!' : 'Copy'}</span>
                          </Button>
                        </div>

                        <Button
                          onClick={() => window.open(uploadResult.secure_url, '_blank')}
                          size="sm"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                          Open File
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <AlertTriangle className="h-5 w-5 text-red-600" />
                      <h3 className="font-medium text-red-900 dark:text-red-100">
                        Upload Failed
                      </h3>
                    </div>
                    <p className="text-sm text-red-700 dark:text-red-300">
                      {uploadResult?.message || 'The file upload encountered an error.'}
                    </p>
                  </div>
                  {rawContent && (
                    <div className="bg-zinc-100 dark:bg-neutral-900 rounded-lg overflow-hidden border border-zinc-200/20">
                      <div className="bg-accent px-4 py-2 flex items-center gap-2">
                        <AlertTriangle className="h-4 w-4 text-zinc-600 dark:text-zinc-400" />
                        <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                          Error Details
                        </span>
                      </div>
                      <div className="p-4 max-h-96 overflow-auto scrollbar-hide">
                        <pre className="text-xs text-zinc-600 dark:text-zinc-300 font-mono whitespace-pre-wrap break-all">
                          {rawContent}
                        </pre>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
} 