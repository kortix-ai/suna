'use client';

import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, ExternalLink, FileText } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  FileContentRenderer,
  FileSourceProvider,
  getFileCategory,
  type BinaryBlobResult,
  type FileContent,
  type FileContentResult,
  type FileSource,
} from '@/features/file-viewer';
import { cn } from '@/lib/utils';

export interface PublicFileShare {
  label: string;
  file_path: string | null;
}

function fileNameFromPath(path: string | null | undefined, fallback = 'Shared file') {
  if (!path) return fallback;
  return path.split('/').filter(Boolean).at(-1) || fallback;
}

function isTextResponse(filePath: string, contentType: string) {
  if (
    contentType.startsWith('text/')
    || contentType.includes('json')
    || contentType.includes('javascript')
    || contentType.includes('xml')
    || contentType.includes('yaml')
    || contentType.includes('toml')
  ) {
    return true;
  }
  return ['code', 'text', 'csv', 'html'].includes(getFileCategory(filePath, contentType));
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function usePublicFileContent(
  token: string,
  filePath: string | null,
  fileUrl: string,
): FileContentResult {
  const query = useQuery<FileContent>({
    queryKey: ['public-file-share', token, 'content', filePath, fileUrl],
    enabled: Boolean(token && filePath && fileUrl),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async () => {
      const res = await fetch(fileUrl, { cache: 'no-store' });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || res.statusText || `HTTP ${res.status}`);
      }
      const mimeType = res.headers.get('content-type') || 'application/octet-stream';
      if (isTextResponse(filePath!, mimeType)) {
        return { type: 'text', content: await res.text(), mimeType };
      }
      return {
        type: 'binary',
        content: arrayBufferToBase64(await res.arrayBuffer()),
        encoding: 'base64',
        mimeType,
      };
    },
  });

  return {
    data: query.data,
    isLoading: query.isLoading,
    error: query.error,
    refetch: () => query.refetch(),
  };
}

function usePublicBinaryBlob(
  token: string,
  filePath: string | null,
  fileUrl: string,
): BinaryBlobResult {
  const query = useQuery<Blob>({
    queryKey: ['public-file-share', token, 'blob', filePath, fileUrl],
    enabled: Boolean(token && filePath && fileUrl),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async () => {
      const res = await fetch(fileUrl, { cache: 'no-store' });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || res.statusText || `HTTP ${res.status}`);
      }
      return res.blob();
    },
  });

  const blobUrl = useMemo(() => {
    if (!query.data) return null;
    return URL.createObjectURL(query.data);
  }, [query.data]);

  useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [blobUrl]);

  return {
    blobUrl,
    blob: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : query.error ? String(query.error) : null,
  };
}

function PublicFileBreadcrumbs({ filePath }: { filePath: string }) {
  const parts = filePath.replace(/^\/workspace\/?/, '').split('/').filter(Boolean);
  return (
    <div className="flex min-w-0 items-center gap-1 text-xs">
      <span className="text-muted-foreground shrink-0">workspace</span>
      {parts.map((part, index) => (
        <span key={`${part}-${index}`} className="flex min-w-0 items-center gap-1">
          <span className="text-muted-foreground/40">/</span>
          <span
            className={cn(
              'truncate',
              index === parts.length - 1 ? 'text-foreground font-medium' : 'text-muted-foreground',
            )}
          >
            {part}
          </span>
        </span>
      ))}
    </div>
  );
}

export function PublicFileShareView({
  token,
  share,
  fileUrl,
}: {
  token: string;
  share: PublicFileShare;
  fileUrl: string;
}) {
  const filePath = share.file_path || share.label;
  const fileName = fileNameFromPath(filePath, share.label);
  const isHtmlFile = getFileCategory(fileName) === 'html';

  const source = useMemo<FileSource>(() => ({
    useFileContent: (path) => usePublicFileContent(token, path, fileUrl),
    useBinaryBlob: (path) => usePublicBinaryBlob(token, path, fileUrl),
    download: async (_filePath, name) => {
      const res = await fetch(fileUrl, { cache: 'no-store' });
      if (!res.ok) throw new Error(res.statusText || `HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name || fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    upload: async () => {
      throw new Error('Public file shares are read-only');
    },
    Breadcrumbs: PublicFileBreadcrumbs,
  }), [fileName, fileUrl, token]);

  if (isHtmlFile) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <div className="border-border/60 flex h-11 shrink-0 items-center gap-2 border-b px-3">
          <FileText className="text-muted-foreground h-4 w-4 shrink-0" />
          <PublicFileBreadcrumbs filePath={filePath} />
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => window.open(fileUrl, '_blank', 'noopener,noreferrer')}
            >
              <ExternalLink className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => source.download(filePath, fileName)}
            >
              <Download className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <iframe
          title={fileName}
          src={fileUrl}
          className="min-h-0 flex-1 border-0 bg-white"
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-downloads"
        />
      </div>
    );
  }

  return (
    <FileSourceProvider value={source}>
      <FileContentRenderer filePath={filePath} readOnly className="h-full bg-background" />
    </FileSourceProvider>
  );
}
