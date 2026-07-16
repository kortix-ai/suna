'use client';

import { AlertTriangle, Download } from 'lucide-react';
import { PowerPointViewer, type ViewerTheme } from 'pptx-react-viewer';
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { I18nextProvider } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { downloadFile } from '@/features/files/api/opencode-files';
import { cn } from '@/lib/utils';

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
 * pptx-react-viewer measures its own container width and, below 1024px,
 * swaps to a phone-optimized layout (bottom tab bar, full-screen sheets for
 * the slides/notes panels) with no prop to opt out. We always want the
 * regular desktop chrome — a persistent, open-by-default slides sidebar —
 * so the stage below is never narrower than this, and is scaled down
 * (visually only, not in layout) to fit smaller panels instead of
 * triggering that responsive swap. A few px of buffer over the library's
 * exact 1024px breakpoint avoids sub-pixel ResizeObserver rounding landing
 * just under it.
 */
const PPTX_DESKTOP_STAGE_WIDTH = 1040;

/**
 * Scales the fixed-width desktop stage down to fit a narrower viewport, never
 * up. Uses a callback ref (rather than a plain `useRef`) so the observer
 * attaches exactly when the viewport element mounts — it doesn't exist yet on
 * first render, since the viewer only appears once the file bytes finish
 * loading.
 */
function usePptxStageScale(): [(node: HTMLDivElement | null) => void, number] {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    if (!node || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? node.clientWidth;
      setScale(Math.min(1, width / PPTX_DESKTOP_STAGE_WIDTH));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);

  return [setNode, scale];
}

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
  const [viewportRef, stageScale] = usePptxStageScale();

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
        <div className="bg-muted flex h-10 w-10 items-center justify-center rounded-full">
          <AlertTriangle className="text-muted-foreground h-4 w-4" />
        </div>
        <p className="text-muted-foreground text-sm">Couldn&apos;t display this presentation.</p>
        <Button size="sm" variant="outline" onClick={handleDownload} disabled={busy}>
          {busy ? <KortixLoader size="small" /> : <Download className="mr-2 h-4 w-4" />}
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
      ref={viewportRef}
      className={cn(
        'bg-background flex h-full w-full items-center justify-center overflow-hidden',
        className,
      )}
    >
      <div
        data-pptx-minimal=""
        className="h-full flex-none"
        style={{
          width: stageScale < 1 ? PPTX_DESKTOP_STAGE_WIDTH : '100%',
          transform: stageScale < 1 ? `scale(${stageScale})` : undefined,
        }}
      >
        <I18nextProvider i18n={getPptxI18n()}>
          <PowerPointViewer
            content={bytes}
            fileName={fileName}
            canEdit={false}
            theme={KORTIX_VIEWER_THEME}
            className="h-full min-h-0 w-full"
          />
        </I18nextProvider>
      </div>
    </div>
  );
}
