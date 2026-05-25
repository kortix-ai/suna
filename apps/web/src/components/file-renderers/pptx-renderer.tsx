'use client';

import { useTranslations } from 'next-intl';

import React, { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Download, FileText } from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { getAuthToken } from '@/lib/auth-token';
import { getActiveOpenCodeUrl } from '@/stores/server-store';
import { downloadFile } from '@/features/files/api/opencode-files';

// ---------------------------------------------------------------------------
// Lazy-load react-doc-viewer (only used when a public URL is available)
// ---------------------------------------------------------------------------
const DocViewerLazy = lazy(async () => {
  try {
    const mod = await import('@cyntler/react-doc-viewer');
    return { default: mod.default } as any;
  } catch {
    return { default: (() => null) as React.FC<any> } as any;
  }
}) as React.LazyExoticComponent<React.ComponentType<any>>;

let _docViewerRenderers: any[] | null = null;
async function getDocViewerRenderers() {
  if (_docViewerRenderers) return _docViewerRenderers;
  try {
    const mod = await import('@cyntler/react-doc-viewer');
    _docViewerRenderers = mod.DocViewerRenderers;
    return _docViewerRenderers;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PptxRendererProps {
  content?: string | null;
  binaryUrl?: string | null;
  blob?: Blob | null;
  filePath?: string;
  fileName: string;
  className?: string;
  sandboxId?: string;
  project?: {
    sandbox?: {
      id?: string;
      sandbox_url?: string;
    };
  };
  onDownload?: () => void;
  isDownloading?: boolean;
  onFullScreen?: () => void;
}

// ---------------------------------------------------------------------------
// Office Online viewer via react-doc-viewer
// ---------------------------------------------------------------------------

function OfficeOnlineViewer({
  fileUrl,
  fileName,
  className,
  onError,
}: {
  fileUrl: string;
  fileName: string;
  className?: string;
  onError: () => void;
}) {
  const [renderers, setRenderers] = useState<any[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    getDocViewerRenderers().then((r) => {
      if (r) setRenderers(r);
      else {
        setLoadFailed(true);
        onError();
      }
    });
  }, [onError]);

  if (loadFailed) return null;
  if (!renderers) {
    return (
      <div className={cn('w-full h-full flex items-center justify-center', className)}>
        <KortixLoader size="medium" />
      </div>
    );
  }

  return (
    <Suspense
      fallback={
        <div className={cn('w-full h-full flex items-center justify-center', className)}>
          <KortixLoader size="medium" />
        </div>
      }
    >
      <div className={cn('w-full h-full', className)} style={{ minHeight: '500px' }}>
        <DocViewerLazy
          documents={[
            {
              uri: fileUrl,
              fileName,
              fileType: fileName.endsWith('.ppt') ? 'ppt' : 'pptx',
            },
          ]}
          pluginRenderers={renderers}
          config={{ header: { disableHeader: true, disableFileName: true } }}
          style={{ width: '100%', height: '100%', minHeight: '500px' }}
        />
      </div>
    </Suspense>
  );
}

// ---------------------------------------------------------------------------
// Detect if sandbox URL is publicly accessible (not localhost)
// ---------------------------------------------------------------------------

function isPublicUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    return (
      host !== 'localhost' &&
      host !== '127.0.0.1' &&
      host !== '0.0.0.0' &&
      !host.startsWith('192.168.') &&
      !host.startsWith('10.') &&
      !host.endsWith('.local')
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Download fallback (local dev / no public URL)
// ---------------------------------------------------------------------------

function PptxDownloadFallback({
  fileName,
  filePath,
  blob,
  onDownload,
  isDownloading,
  className,
}: {
  fileName: string;
  filePath?: string;
  blob?: Blob | null;
  onDownload?: () => void;
  isDownloading?: boolean;
  className?: string;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [downloading, setDownloading] = useState(false);

  const handleDownload = useCallback(async () => {
    if (onDownload) {
      onDownload();
      return;
    }

    // Direct blob download
    if (blob) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      return;
    }

    // Fetch and download via file API
    if (filePath) {
      setDownloading(true);
      try {
        await downloadFile(filePath, fileName);
      } finally {
        setDownloading(false);
      }
    }
  }, [onDownload, blob, filePath, fileName]);

  const busy = isDownloading || downloading;

  return (
    <div className={cn('w-full h-full flex items-center justify-center', className)}>
      <div className="text-center space-y-4 p-8">
        <div className="mx-auto w-16 h-16 rounded-xl bg-muted/50 flex items-center justify-center">
          <FileText className="h-8 w-8 text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">{fileName}</p>
          <p className="text-xs text-muted-foreground">{tHardcodedUi.raw('componentsFileRenderersPptxRenderer.line203JsxTextPowerpointPreviewRequiresACloudSandbox')}</p>
        </div>
        <Button size="sm" onClick={handleDownload} disabled={busy}>
          {busy ? (
            <KortixLoader size="small" />
          ) : (
            <Download className="h-4 w-4 mr-2" />
          )}{tHardcodedUi.raw('componentsFileRenderersPptxRenderer.line212JsxTextDownloadToView')}</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main PptxRenderer
// ---------------------------------------------------------------------------

export function PptxRenderer({
  blob,
  binaryUrl,
  filePath,
  fileName,
  className,
  project,
  onDownload,
  isDownloading,
}: PptxRendererProps) {
  const [useOfficeOnline, setUseOfficeOnline] = useState<boolean | null>(null);
  const [publicFileUrl, setPublicFileUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function resolveUrl() {
      const serverUrl = getActiveOpenCodeUrl();

      if (!isPublicUrl(serverUrl) || !filePath) {
        setUseOfficeOnline(false);
        return;
      }

      const token = await getAuthToken();
      const rawUrl = new URL(`${serverUrl}/file/raw`);
      rawUrl.searchParams.set('path', filePath);
      if (token) {
        rawUrl.searchParams.set('token', token);
      }

      if (!cancelled) {
        setPublicFileUrl(rawUrl.toString());
        setUseOfficeOnline(true);
      }
    }

    resolveUrl();
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const handleOfficeOnlineError = useCallback(() => {
    setUseOfficeOnline(false);
  }, []);

  // Still resolving...
  if (useOfficeOnline === null) {
    return (
      <div className={cn('w-full h-full flex items-center justify-center', className)}>
        <KortixLoader size="medium" />
      </div>
    );
  }

  // Office Online path
  if (useOfficeOnline && publicFileUrl) {
    return (
      <OfficeOnlineViewer
        fileUrl={publicFileUrl}
        fileName={fileName}
        className={className}
        onError={handleOfficeOnlineError}
      />
    );
  }

  // Fallback: download button
  return (
    <PptxDownloadFallback
      fileName={fileName}
      filePath={filePath}
      blob={blob}
      onDownload={onDownload}
      isDownloading={isDownloading}
      className={className}
    />
  );
}
