'use client';

import React, { useState } from 'react';
import { FileText, Table, Image, Download, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { downloadFile } from '@/features/files/api/opencode-files';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FileArtifactData {
  filename: string;
  sandbox_path: string;
  sandbox_id: string;
  mime_type: string;
  size_bytes: number;
  description?: string;
}

export interface FileArtifactMessage {
  type: 'canvas';
  kind: 'file_artifact';
  id: string;
  data: FileArtifactData;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function mimeLabel(mime: string): string {
  const map: Record<string, string> = {
    'application/pdf': 'PDF',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel',
    'text/csv': 'CSV',
    'image/png': 'PNG',
    'image/jpeg': 'JPEG',
  };
  return map[mime] ?? mime.split('/').pop()?.toUpperCase() ?? 'File';
}

function MimeIcon({ mime, className }: { mime: string; className?: string }) {
  if (mime === 'image/png' || mime === 'image/jpeg') {
    return <Image className={cn('h-5 w-5', className)} />;
  }
  if (mime === 'text/csv' || mime.includes('spreadsheet') || mime.includes('excel')) {
    return <Table className={cn('h-5 w-5', className)} />;
  }
  return <FileText className={cn('h-5 w-5', className)} />;
}

// ─── Component ───────────────────────────────────────────────────────────────

interface FileArtifactCardProps {
  message: FileArtifactMessage;
  className?: string;
}

export function FileArtifactCard({ message, className }: FileArtifactCardProps) {
  const { filename, sandbox_path, mime_type, size_bytes, description } = message.data;
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sizeStr = formatBytes(size_bytes);
  const typeStr = mimeLabel(mime_type);

  const handleDownload = async () => {
    setDownloading(true);
    setError(null);
    try {
      await downloadFile(sandbox_path, filename);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50 p-4',
        className,
      )}
    >
      {/* Icon */}
      <div className="flex-shrink-0 mt-0.5">
        <MimeIcon
          mime={mime_type}
          className="text-zinc-500 dark:text-zinc-400"
        />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate" title={filename}>
          {filename}
        </p>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          {typeStr}
          {sizeStr && ` · ${sizeStr}`}
        </p>
        {description && (
          <p className="mt-1.5 text-xs text-zinc-600 dark:text-zinc-300 line-clamp-2">
            {description}
          </p>
        )}
        {error && (
          <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>
        )}
      </div>

      {/* Download button */}
      <Button
        variant="outline"
        size="sm"
        onClick={handleDownload}
        disabled={downloading}
        className="flex-shrink-0 gap-1.5 text-xs h-8"
      >
        {downloading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Download className="h-3.5 w-3.5" />
        )}
        {downloading ? 'Downloading…' : 'Download'}
      </Button>
    </div>
  );
}
