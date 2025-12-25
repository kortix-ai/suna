import React, { useMemo, useState, useRef } from 'react';
import { AlertTriangle, Play, Pause, Wand2, CheckCircle, Loader2, Download, Video as VideoIcon, Image as ImageIcon } from 'lucide-react';
import { ToolViewProps } from '../types';
import { extractImageEditGenerateData } from './_utils';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useImageContent } from '@/hooks/files';
import { useFileContentQuery } from '@/hooks/files/use-file-queries';
import { VideoRenderer } from '@/components/file-renderers/video-renderer';

const BLOB_COLORS = [
  'from-purple-300/60 to-pink-300/60',
  'from-blue-300/60 to-cyan-300/60',
  'from-emerald-300/60 to-teal-300/60',
  'from-orange-300/60 to-amber-300/60',
  'from-rose-300/60 to-red-300/60',
  'from-indigo-300/60 to-violet-300/60',
];

function ShimmerBox({ aspectVideo = false }: { aspectVideo?: boolean }) {
  // Use ref to store color so it doesn't change on re-renders
  const colorRef = useRef(BLOB_COLORS[Math.floor(Math.random() * BLOB_COLORS.length)]);
  const [showColor, setShowColor] = useState(false);
  
  // Fade in color after a delay
  React.useEffect(() => {
    const timer = setTimeout(() => setShowColor(true), 800);
    return () => clearTimeout(timer);
  }, []);
  
  return (
    <div className={`relative w-full ${aspectVideo ? 'aspect-video' : 'aspect-square'} rounded-2xl overflow-hidden border border-neutral-200 dark:border-neutral-700/50`}>
      {/* Gray base layer */}
      <div className="absolute inset-0 bg-gradient-to-br from-zinc-300/60 to-zinc-400/60 dark:from-zinc-600/60 dark:to-zinc-700/60 blur-2xl scale-150" />
      {/* Color layer that fades in */}
      <div 
        className={`absolute inset-0 bg-gradient-to-br ${colorRef.current} blur-2xl scale-150 transition-opacity duration-1000`}
        style={{ opacity: showColor ? 1 : 0 }}
      />
      <div className="absolute inset-0 bg-zinc-100/30 dark:bg-zinc-900/30 backdrop-blur-sm" />
      <div
        className="absolute inset-0"
        style={{
          background: 'linear-gradient(110deg, transparent 30%, rgba(255,255,255,0.4) 50%, transparent 70%)',
          backgroundSize: '200% 100%',
          animation: 'media-shimmer 1.8s ease-in-out infinite',
        }}
      />
      <style>{`
        @keyframes media-shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
    </div>
  );
}

function ImageDisplay({ filePath, sandboxId }: { filePath: string; sandboxId?: string }) {
  const { data: imageUrl, isLoading } = useImageContent(sandboxId, filePath, {
    enabled: !!sandboxId && !!filePath,
  });

  if (isLoading || !imageUrl) {
    return <ShimmerBox />;
  }

  return (
    <img
      src={imageUrl}
      alt={filePath}
      className="w-full rounded-2xl border border-neutral-200 dark:border-neutral-700/50 object-contain"
    />
  );
}

function VideoDisplay({ filePath, sandboxId }: { filePath: string; sandboxId?: string }) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isVideoLoading, setIsVideoLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const urlCacheRef = useRef<Map<Blob, string>>(new Map());

  // Use the same file content approach that images use - fetch blob with proper auth
  const { data: videoBlob, isLoading: isBlobLoading } = useVideoContent(sandboxId, filePath, {
    enabled: !!sandboxId && !!filePath,
  });
  
  // Create blob URL from the video data - cache to prevent revocation on navigation
  const videoUrl = useMemo(() => {
    if (videoBlob instanceof Blob) {
      if (urlCacheRef.current.has(videoBlob)) {
        return urlCacheRef.current.get(videoBlob)!;
      }
      const newUrl = URL.createObjectURL(videoBlob);
      urlCacheRef.current.set(videoBlob, newUrl);
      return newUrl;
    }
    return null;
  }, [videoBlob]);
  
  // Only cleanup on final unmount
  React.useEffect(() => {
    return () => {
      const cachedUrls = Array.from(urlCacheRef.current.values());
      cachedUrls.forEach(url => URL.revokeObjectURL(url));
      urlCacheRef.current.clear();
    };
  }, []);

  const togglePlay = () => {
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause();
      } else {
        videoRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  // Show shimmer while loading blob
  if (isBlobLoading || !videoUrl) {
    return <ShimmerBox aspectVideo />;
  }

  if (hasError) {
    return (
      <div className="aspect-video flex flex-col items-center justify-center p-4 text-center rounded-2xl border border-neutral-200 dark:border-neutral-700/50 bg-muted/30">
        <AlertTriangle className="h-8 w-8 text-destructive mb-2" />
        <p className="text-destructive font-medium text-sm">Failed to load video</p>
      </div>
    );
  }

  return (
    <div className="relative rounded-2xl overflow-hidden border border-neutral-200 dark:border-neutral-700/50 bg-black">
      {isVideoLoading && (
        <div className="absolute inset-0 z-10">
          <ShimmerBox aspectVideo />
        </div>
      )}
      <div className="relative group">
        <video
          ref={videoRef}
          src={videoUrl}
          className="w-full aspect-video object-contain"
          loop
          muted
          playsInline
          onLoadedData={() => setIsVideoLoading(false)}
          onError={() => {
            setHasError(true);
            setIsVideoLoading(false);
          }}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => setIsPlaying(false)}
        />
        {/* Play/Pause overlay */}
        <div
          className="absolute inset-0 flex items-center justify-center cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity bg-black/20"
          onClick={togglePlay}
        >
          <div className="h-14 w-14 rounded-full bg-white/90 dark:bg-black/90 flex items-center justify-center shadow-lg">
            {isPlaying ? (
              <Pause className="h-7 w-7 text-foreground" />
            ) : (
              <Play className="h-7 w-7 text-foreground ml-0.5" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Hook for video content - similar to useImageContent but for video
function useVideoContent(
  sandboxId?: string,
  filePath?: string,
  options: { enabled?: boolean } = {}
) {
  const { data, isLoading, error } = useFileContentQuery(sandboxId, filePath, {
    contentType: 'blob',
    enabled: options.enabled,
    staleTime: 5 * 60 * 1000,
  });

  return { data, isLoading, error };
}

// Full featured video renderer component for tool view (Computer)
// Uses the full VideoRenderer with all controls (slider, volume, etc.)
function VideoRendererFull({ filePath, sandboxId }: { filePath: string; sandboxId?: string }) {
  const urlCacheRef = useRef<Map<Blob, string>>(new Map());
  
  // Fetch video blob with proper auth
  const { data: videoBlob, isLoading } = useVideoContent(sandboxId, filePath, {
    enabled: !!sandboxId && !!filePath,
  });
  
  // Create blob URL from the video data - cache URLs per blob to prevent recreation
  const videoUrl = useMemo(() => {
    if (videoBlob instanceof Blob) {
      // Check if we already have a URL for this blob
      if (urlCacheRef.current.has(videoBlob)) {
        return urlCacheRef.current.get(videoBlob)!;
      }
      // Create new URL and cache it
      const newUrl = URL.createObjectURL(videoBlob);
      urlCacheRef.current.set(videoBlob, newUrl);
      return newUrl;
    }
    return null;
  }, [videoBlob]);
  
  // Only cleanup blob URLs when component permanently unmounts (not on navigation)
  // This prevents "blob not found" errors when going back in history
  React.useEffect(() => {
    return () => {
      // Cleanup all cached URLs on final unmount
      const cachedUrls = Array.from(urlCacheRef.current.values());
      cachedUrls.forEach(url => URL.revokeObjectURL(url));
      urlCacheRef.current.clear();
    };
  }, []); // Empty deps = only run on mount/unmount

  if (isLoading || !videoUrl) {
    return <ShimmerBox aspectVideo />;
  }

  return (
    <div className="w-full rounded-2xl overflow-hidden">
      <VideoRenderer 
        url={videoUrl}
        loop={true}
      />
    </div>
  );
}

interface ImageEditGenerateToolViewProps extends ToolViewProps {
  onFileClick?: (filePath: string) => void;
}

export function ImageEditGenerateToolView({
  toolCall,
  toolResult,
  isStreaming = false,
  project,
}: ImageEditGenerateToolViewProps) {
  if (!toolCall) return null;

  const {
    generatedImagePaths,
    generatedVideoPaths,
    isVideoMode,
    error,
    batchResults,
  } = extractImageEditGenerateData(toolCall, toolResult, true);

  const sandboxId = project?.sandbox?.id;
  const imagePath = generatedImagePaths[0];
  const videoPath = generatedVideoPaths[0];
  const hasMedia = imagePath || videoPath;
  
  // ONLY show error if:
  // 1. Not streaming (still processing)
  // 2. We have a result (toolResult exists)
  // 3. The result explicitly failed (has error or failed batch)
  // 4. No media was produced
  const hasActualError = !isStreaming && 
    toolResult && 
    !hasMedia && 
    (!!error || (batchResults.length > 0 && !batchResults[0].success));

  const actualIsSuccess = hasMedia && !hasActualError;

  // Cache for download URLs to prevent revocation issues on navigation
  const downloadUrlCacheRef = useRef<Map<Blob, string>>(new Map());

  // Get media blob URL for download
  const { data: mediaBlob } = useFileContentQuery(sandboxId, videoPath || imagePath, {
    contentType: 'blob',
    enabled: !!sandboxId && !!(videoPath || imagePath) && actualIsSuccess,
  });

  // Create download URL - cache per blob to survive navigation
  const downloadUrl = useMemo(() => {
    if (mediaBlob instanceof Blob) {
      if (downloadUrlCacheRef.current.has(mediaBlob)) {
        return downloadUrlCacheRef.current.get(mediaBlob)!;
      }
      const newUrl = URL.createObjectURL(mediaBlob);
      downloadUrlCacheRef.current.set(mediaBlob, newUrl);
      return newUrl;
    }
    return null;
  }, [mediaBlob]);

  // Only cleanup on final unmount, not on navigation
  React.useEffect(() => {
    return () => {
      const cachedUrls = Array.from(downloadUrlCacheRef.current.values());
      cachedUrls.forEach(url => URL.revokeObjectURL(url));
      downloadUrlCacheRef.current.clear();
    };
  }, []);

  const handleDownload = () => {
    if (!downloadUrl) return;
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = (videoPath || imagePath || 'media').split('/').pop() || 'media';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      {/* Header */}
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-lg border shrink-0 bg-purple-200/60 dark:bg-purple-900 border-purple-300 dark:border-purple-700">
              {videoPath ? (
                <VideoIcon className="w-5 h-5 text-purple-600 dark:text-purple-400" />
              ) : (
                <ImageIcon className="w-5 h-5 text-purple-600 dark:text-purple-400" />
              )}
            </div>
            <div>
              <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                Generate Media
              </CardTitle>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {!isStreaming && actualIsSuccess && (
              <Badge
                variant="secondary"
                className="bg-gradient-to-b from-emerald-200 to-emerald-100 text-emerald-700 dark:from-emerald-800/50 dark:to-emerald-900/60 dark:text-emerald-300"
              >
                <CheckCircle className="h-3.5 w-3.5 mr-1" />
                Success
              </Badge>
            )}

            {!isStreaming && hasActualError && (
              <Badge
                variant="secondary"
                className="bg-gradient-to-b from-rose-200 to-rose-100 text-rose-700 dark:from-rose-800/50 dark:to-rose-900/60 dark:text-rose-300"
              >
                <AlertTriangle className="h-3.5 w-3.5 mr-1" />
                Failed
              </Badge>
            )}

            {isStreaming && (
              <Badge className="bg-gradient-to-b from-blue-200 to-blue-100 text-blue-700 dark:from-blue-800/50 dark:to-blue-900/60 dark:text-blue-300">
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                Processing
              </Badge>
            )}

            {/* Download button */}
            {actualIsSuccess && downloadUrl && (
              <Button
                onClick={handleDownload}
                variant="outline"
                size="sm"
                className="h-7"
              >
                <Download className="h-3.5 w-3.5 mr-1.5" />
                Download
              </Button>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-4">
        {isStreaming || !toolResult ? (
          /* Streaming/Loading State - ALWAYS show shimmer when streaming or no result yet */
          <ShimmerBox aspectVideo={isVideoMode} />
        ) : hasActualError ? (
          /* Error State - Only after streaming complete AND actual failure */
          <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
            <div className="w-16 h-16 rounded-full flex items-center justify-center mb-4 bg-gradient-to-b from-rose-100 to-rose-50 dark:from-rose-800/40 dark:to-rose-900/60">
              <AlertTriangle className="h-8 w-8 text-rose-500 dark:text-rose-400" />
            </div>
            <h3 className="text-base font-medium text-zinc-900 dark:text-zinc-100 mb-2">
              Processing Failed
            </h3>
            <p className="text-sm text-zinc-600 dark:text-zinc-400 max-w-md">
              {error || batchResults[0]?.error || 'An error occurred during processing.'}
            </p>
          </div>
        ) : videoPath ? (
          /* Success State - Show FULL video player */
          <VideoRendererFull filePath={videoPath} sandboxId={sandboxId} />
        ) : imagePath ? (
          /* Success State - Show image */
          <ImageDisplay filePath={imagePath} sandboxId={sandboxId} />
        ) : (
          /* Fallback shimmer if no media yet */
          <ShimmerBox aspectVideo={isVideoMode} />
        )}
      </CardContent>
    </Card>
  );
}
