/**
 * KanvaxPreview - Non-interactive canvas preview for .kanvax files
 */

import React, { useMemo, useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { useFileData } from '@/hooks/use-file-data';

interface CanvasElement {
  id: string;
  type: 'image' | 'frame';
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  opacity?: number;
  visible?: boolean;
  name: string;
  src?: string;
  backgroundColor?: string;
}

interface CanvasData {
  name: string;
  version?: string;
  background: string;
  elements: CanvasElement[];
}

export interface KanvaxPreviewProps {
  filepath: string;
  sandboxId?: string;
  localPreviewUrl?: string;
  className?: string;
  onClick?: () => void;
}

// Image element
function CanvasImageElement({
  src,
  sandboxId,
  style,
  elementId,
}: {
  src: string;
  sandboxId?: string;
  style: React.CSSProperties;
  elementId: string;
}) {
  const isBase64 = src.startsWith('data:');
  const isExternalUrl = src.startsWith('http://') || src.startsWith('https://');
  const needsAuth = sandboxId && !isBase64 && !isExternalUrl;

  const normalizedPath = useMemo(() => {
    if (!needsAuth) return '';
    let path = src;
    if (path.startsWith('/')) path = path.substring(1);
    if (path.startsWith('workspace/')) path = path.substring(10);
    return `/workspace/${path}`;
  }, [src, needsAuth]);

  const { data: blobUrl, isLoading } = useFileData(
    needsAuth ? sandboxId : undefined,
    needsAuth ? normalizedPath : undefined,
    { enabled: !!needsAuth, showPreview: true }
  );

  let imageSrc: string | null = null;
  if (isBase64 || isExternalUrl) {
    imageSrc = src;
  } else if (needsAuth && blobUrl) {
    imageSrc = blobUrl;
  }

  if (needsAuth && isLoading) {
    return <div style={style} className="bg-black/20 animate-pulse" />;
  }

  if (!imageSrc) {
    return <div style={style} className="bg-muted/50" />;
  }

  return (
    <img
      src={imageSrc}
      alt=""
      style={style}
      draggable={false}
    />
  );
}

export function KanvaxPreview({
  filepath,
  sandboxId,
  localPreviewUrl,
  className,
  onClick,
}: KanvaxPreviewProps) {
  const [localData, setLocalData] = useState<string | null>(null);
  const [localLoading, setLocalLoading] = useState(false);
  const [localError, setLocalError] = useState<Error | null>(null);
  const [isHovered, setIsHovered] = useState(false);

  useEffect(() => {
    if (!localPreviewUrl) {
      setLocalData(null);
      return;
    }
    setLocalLoading(true);
    fetch(localPreviewUrl)
      .then(res => res.text())
      .then(text => {
        setLocalData(text);
        setLocalLoading(false);
      })
      .catch(err => {
        setLocalError(err);
        setLocalLoading(false);
      });
  }, [localPreviewUrl]);

  const shouldFetchFromSandbox = !localPreviewUrl && !!sandboxId;

  const { data: sandboxData, isLoading: sandboxLoading, error: sandboxError, retryCount } = useFileData(
    shouldFetchFromSandbox ? sandboxId : undefined,
    shouldFetchFromSandbox ? filepath : undefined,
    { enabled: shouldFetchFromSandbox, showPreview: true }
  );

  const data = localData || sandboxData;
  const isLoading = localPreviewUrl ? localLoading : sandboxLoading;
  const error = localPreviewUrl ? localError : sandboxError;

  const canvasData = useMemo(() => {
    if (!data) return null;
    try {
      return JSON.parse(data) as CanvasData;
    } catch {
      return null;
    }
  }, [data]);

  const viewBox = useMemo(() => {
    if (!canvasData?.elements?.length) return null;

    const visible = canvasData.elements.filter(el => el.visible !== false);
    if (!visible.length) return null;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const el of visible) {
      minX = Math.min(minX, el.x);
      minY = Math.min(minY, el.y);
      maxX = Math.max(maxX, el.x + el.width);
      maxY = Math.max(maxY, el.y + el.height);
    }

    const w = maxX - minX;
    const h = maxY - minY;
    const pad = Math.max(w, h) * 0.05;

    return { x: minX - pad, y: minY - pad, width: w + pad * 2, height: h + pad * 2 };
  }, [canvasData]);

  if (isLoading || (!localPreviewUrl && !data && retryCount < 15)) {
    return (
      <div className={cn("h-full w-full flex items-center justify-center bg-muted", className)}>
        <KortixLoader size="medium" />
      </div>
    );
  }

  if (error || !canvasData) {
    return (
      <div className={cn("h-full w-full flex items-center justify-center bg-muted text-muted-foreground text-xs", className)}>
        Failed to load
      </div>
    );
  }

  if (!viewBox) {
    return (
      <div className={cn("h-full w-full flex items-center justify-center bg-muted text-muted-foreground text-xs", className)}>
        Empty
      </div>
    );
  }

  const visible = canvasData.elements.filter(el => el.visible !== false);
  // Sort: frames behind images
  const sorted = [...visible].sort((a, b) => {
    if (a.type === 'frame' && b.type !== 'frame') return -1;
    if (a.type !== 'frame' && b.type === 'frame') return 1;
    return 0;
  });

  // Calculate aspect ratio to maintain proper proportions
  const aspectRatio = viewBox.width / viewBox.height;

  return (
    <div
      className={cn("h-full w-full overflow-hidden relative cursor-pointer", className)}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={onClick}
    >
      {/* Canvas background */}
      <div
        className="absolute inset-0 flex items-center justify-center"
        style={{ backgroundColor: canvasData.background || '#1a1a1a' }}
      >
        {/* Content container - maintains aspect ratio */}
        <div
          className="relative"
          style={{
            width: '100%',
            height: '100%',
            maxWidth: aspectRatio >= 1 ? '100%' : `${aspectRatio * 100}%`,
            maxHeight: aspectRatio >= 1 ? `${100 / aspectRatio}%` : '100%',
            aspectRatio: `${viewBox.width} / ${viewBox.height}`,
          }}
        >
          {sorted.map((el) => {
            const left = ((el.x - viewBox.x) / viewBox.width) * 100;
            const top = ((el.y - viewBox.y) / viewBox.height) * 100;
            const width = (el.width / viewBox.width) * 100;
            const height = (el.height / viewBox.height) * 100;

            const style: React.CSSProperties = {
              position: 'absolute',
              left: `${left}%`,
              top: `${top}%`,
              width: `${width}%`,
              height: `${height}%`,
              opacity: el.opacity ?? 1,
              transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined,
              transformOrigin: 'center',
            };

            // FRAME
            if (el.type === 'frame') {
              return (
                <div
                  key={el.id}
                  style={{
                    ...style,
                    backgroundColor: el.backgroundColor || '#444444',
                  }}
                />
              );
            }

            // IMAGE
            if (el.type === 'image' && el.src) {
              return (
                <CanvasImageElement
                  key={el.id}
                  elementId={el.id}
                  src={el.src}
                  sandboxId={sandboxId}
                  style={style}
                />
              );
            }

            return null;
          })}
        </div>
      </div>

      {/* Hover overlay with Preview text */}
      {isHovered && (
        <div className="absolute inset-0 bg-black/5 flex items-center justify-center">
          <div className="px-3 py-1.5 bg-foreground/90 rounded-full text-xs font-medium text-background">
            Preview
          </div>
        </div>
      )}
    </div>
  );
}
