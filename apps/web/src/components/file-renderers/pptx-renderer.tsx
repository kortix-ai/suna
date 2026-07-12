'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { PowerPointViewer, type ViewerTheme } from 'pptx-react-viewer';
import { I18nextProvider } from 'react-i18next';
import { AlertTriangle, Download } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { downloadFile } from '@/features/files/api/runtime-files';

import { getPptxI18n } from './pptx-i18n';
import './pptx-viewer.css';

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

/**
 * Maps the viewer's shadcn-style theme tokens onto Kortix's own CSS variables
 * so the embedded PowerPoint viewer follows the app's light/dark theme exactly.
 * The library writes both `--pptx-*` and `--color-*` custom properties from
 * these values, so referencing our variables keeps everything in one system.
 */
const KORTIX_VIEWER_THEME: ViewerTheme = {
  colors: {
    background: 'var(--background)',
    foreground: 'var(--foreground)',
    card: 'var(--card)',
    cardForeground: 'var(--card-foreground)',
    popover: 'var(--popover)',
    popoverForeground: 'var(--popover-foreground)',
    primary: 'var(--primary)',
    primaryForeground: 'var(--primary-foreground)',
    secondary: 'var(--secondary)',
    secondaryForeground: 'var(--secondary-foreground)',
    muted: 'var(--muted)',
    mutedForeground: 'var(--muted-foreground)',
    accent: 'var(--accent)',
    accentForeground: 'var(--accent-foreground)',
    destructive: 'var(--destructive)',
    destructiveForeground: 'var(--destructive-foreground)',
    border: 'var(--border)',
    input: 'var(--input)',
    ring: 'var(--ring)',
  },
  radius: 'var(--radius, 0.5rem)',
};

/**
 * PptxRenderer — renders `.pptx`/`.ppt` decks inline with pptx-react-viewer,
 * matching how we render docx/xlsx. Read-only (`canEdit={false}`); a download
 * action is offered only when the file can't be parsed.
 */
export function PptxRenderer({
  blob,
  binaryUrl,
  filePath,
  fileName,
  className,
  onDownload,
  isDownloading,
}: PptxRendererProps) {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setBytes(null);
    setError(null);

    (async () => {
      let source: Blob | null = blob ?? null;
      if (!source && binaryUrl) {
        const resp = await fetch(binaryUrl);
        if (!resp.ok) throw new Error(`Failed to fetch presentation (${resp.status})`);
        source = await resp.blob();
      }
      if (!source) throw new Error('No presentation content available');
      const buffer = await source.arrayBuffer();
      if (cancelled) return;
      setBytes(new Uint8Array(buffer));
    })().catch((err: unknown) => {
      if (cancelled) return;
      console.error('[PptxRenderer] Error loading presentation:', err);
      setError(err instanceof Error ? err.message : 'Failed to load presentation');
    });

    return () => {
      cancelled = true;
    };
  }, [blob, binaryUrl]);

  const handleDownload = useCallback(async () => {
    if (onDownload) {
      onDownload();
      return;
    }
    if (blob) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      return;
    }
    if (filePath) {
      setDownloading(true);
      try {
        await downloadFile(filePath, fileName);
      } finally {
        setDownloading(false);
      }
    }
  }, [onDownload, blob, filePath, fileName]);

  if (error) {
    const busy = isDownloading || downloading;
    return (
      <div
        className={cn(
          'flex h-full w-full flex-col items-center justify-center gap-3 p-8 text-center',
          className,
        )}
      >
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
          <AlertTriangle className="h-4 w-4 text-muted-foreground" />
        </div>
        <p className="text-sm text-muted-foreground">Couldn&apos;t display this presentation.</p>
        <Button size="sm" variant="outline" onClick={handleDownload} disabled={busy}>
          {busy ? <KortixLoader size="small" /> : <Download className="h-4 w-4 mr-2" />}
          Download to view
        </Button>
      </div>
    );
  }

  if (!bytes) {
    return (
      <div className={cn('flex h-full w-full items-center justify-center', className)}>
        <KortixLoader size="medium" />
      </div>
    );
  }

  return (
    <div
      data-pptx-minimal=""
      className={cn('relative flex h-full w-full flex-col overflow-hidden bg-background', className)}
    >
      <I18nextProvider i18n={getPptxI18n()}>
        <PowerPointViewer
          content={bytes}
          fileName={fileName}
          canEdit={false}
          theme={KORTIX_VIEWER_THEME}
          className="h-full w-full min-h-0"
        />
      </I18nextProvider>
    </div>
  );
}
