'use client';

import React, { useMemo, useState, useEffect } from 'react';
import { Play, Pause } from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { useImageContent, useFileContent } from '@/hooks/files';
import { getToolIcon } from '@/components/thread/utils';
import { AppIcon } from '@/components/thread/tool-views/shared/AppIcon';
import type { Project } from '@/lib/api/threads';

interface MediaGenerationInlineProps {
  toolCall: {
    function_name: string;
    arguments?: Record<string, any>;
    tool_call_id?: string;
  };
  toolResult?: {
    output?: string;
    success?: boolean;
    error?: string;
  } | null;
  onToolClick: () => void;
  sandboxId?: string;
  project?: Project;
}

type MediaType = 'image' | 'video' | null;

function extractGeneratedMedia(output: string | undefined): { path: string; type: MediaType } | null {
  if (!output) return null;
  
  // Check for video first - handle /workspace/ prefix
  // Supports filenames with spaces (e.g., "Mock Video abc123.mp4")
  const videoMatch = output.match(/Video saved as:\s*(?:\/workspace\/)?(.+\.(?:mp4|webm|mov))/i);
  if (videoMatch?.[1]) return { path: videoMatch[1].trim(), type: 'video' };
  // Legacy format with underscores
  const directVideoMatch = output.match(/(?:\/workspace\/)?(generated_video_[a-z0-9]+\.(?:mp4|webm|mov))/i);
  if (directVideoMatch?.[1]) return { path: directVideoMatch[1].trim(), type: 'video' };
  
  // Check for image - handle /workspace/ prefix
  // Supports filenames with spaces (e.g., "Geometric Glass Facade.png")
  const imageMatch = output.match(/Image saved as:\s*(?:\/workspace\/)?(.+\.(?:png|jpg|jpeg|webp|gif))/i);
  if (imageMatch?.[1]) return { path: imageMatch[1].trim(), type: 'image' };
  // Legacy format with underscores
  const directImageMatch = output.match(/(?:\/workspace\/)?(generated_image_[a-z0-9]+\.(?:png|jpg|jpeg|webp|gif))/i);
  if (directImageMatch?.[1]) return { path: directImageMatch[1].trim(), type: 'image' };
  
  return null;
}

// Legacy helper for backwards compatibility
function extractGeneratedImage(output: string | undefined): string | null {
  const result = extractGeneratedMedia(output);
  return result?.type === 'image' ? result.path : null;
}

const BLOB_COLORS = [
  'from-zinc-300/60 to-zinc-400/60',
  'from-zinc-350/60 to-zinc-450/60',
  'from-neutral-300/60 to-neutral-400/60',
  'from-stone-300/60 to-stone-400/60',
  'from-gray-300/60 to-gray-400/60',
  'from-slate-300/60 to-slate-400/60',
];

function ShimmerBox({ aspectVideo = false }: { aspectVideo?: boolean }) {
  // Use ref to store color so it doesn't change on re-renders
  const colorRef = React.useRef(BLOB_COLORS[Math.floor(Math.random() * BLOB_COLORS.length)]);
  const [showColor, setShowColor] = useState(false);
  
  // Fade in color after a delay
  useEffect(() => {
    const timer = setTimeout(() => setShowColor(true), 800);
    return () => clearTimeout(timer);
  }, []);
  
  return (
    <div className={`relative w-80 ${aspectVideo ? 'aspect-video' : 'aspect-square'} rounded-2xl overflow-hidden border border-neutral-200 dark:border-neutral-700/50`}>
      {/* Gray base layer - contained with rounded corners */}
      <div className="absolute inset-[-50%] bg-gradient-to-br from-zinc-300/60 to-zinc-400/60 dark:from-zinc-600/60 dark:to-zinc-700/60 blur-2xl" />
      {/* Color layer that fades in - contained with rounded corners */}
      <div 
        className={`absolute inset-[-50%] bg-gradient-to-br ${colorRef.current} blur-2xl transition-opacity duration-1000`}
        style={{ opacity: showColor ? 1 : 0 }}
      />
      <div className="absolute inset-0 bg-zinc-100/30 dark:bg-zinc-900/30 backdrop-blur-sm rounded-2xl" />
      <div
        className="absolute inset-0 rounded-2xl"
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

function InlineImage({ filePath, sandboxId }: { filePath: string; sandboxId?: string }) {
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
      className="w-80 rounded-2xl border border-neutral-200 dark:border-neutral-700/50"
    />
  );
}

function InlineVideo({ filePath, sandboxId }: { filePath: string; sandboxId?: string }) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isVideoLoading, setIsVideoLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const videoRef = React.useRef<HTMLVideoElement>(null);

  // Use the same file content hook that images use - this handles auth and proper URL
  const { data: videoBlob, isLoading: isBlobLoading } = useFileContent(sandboxId, filePath, {
    enabled: !!sandboxId && !!filePath,
  });
  
  // Create and manage blob URL
  useEffect(() => {
    if (videoBlob instanceof Blob) {
      const newUrl = URL.createObjectURL(videoBlob);
      setVideoUrl(newUrl);
      
      return () => {
        URL.revokeObjectURL(newUrl);
        setVideoUrl(null);
      };
    } else {
      setVideoUrl(null);
    }
  }, [videoBlob]);

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

  return (
    <div className="relative w-80 rounded-2xl overflow-hidden border border-neutral-200 dark:border-neutral-700/50 bg-black/5 dark:bg-black/20">
      {isVideoLoading && !hasError && (
        <div className="absolute inset-0 flex items-center justify-center z-10">
          <ShimmerBox aspectVideo />
        </div>
      )}
      {hasError ? (
        <div className="aspect-video flex flex-col items-center justify-center p-4 text-center">
          <p className="text-destructive font-medium text-sm">Failed to load video</p>
        </div>
      ) : (
        <div className="relative group">
          <video
            ref={videoRef}
            src={videoUrl}
            className="w-full aspect-video object-contain bg-black"
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
            <div className="h-12 w-12 rounded-full bg-white/90 dark:bg-black/90 flex items-center justify-center shadow-lg">
              {isPlaying ? (
                <Pause className="h-6 w-6 text-foreground" />
              ) : (
                <Play className="h-6 w-6 text-foreground ml-0.5" />
              )}
            </div>
          </div>
          {/* Progress indicator at bottom */}
          {!isVideoLoading && (
            <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/30">
              <div
                className="h-full bg-white/80 transition-all"
                style={{
                  width: videoRef.current
                    ? `${(videoRef.current.currentTime / (videoRef.current.duration || 1)) * 100}%`
                    : '0%',
                }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function MediaGenerationInline({
  toolCall,
  toolResult,
  onToolClick,
  sandboxId,
  project,
}: MediaGenerationInlineProps) {
  const isComplete = !!toolResult;
  const media = isComplete ? extractGeneratedMedia(toolResult?.output) : null;
  
  // Detect if this is a video generation based on tool arguments
  const isVideoGeneration = toolCall.arguments?.video_options !== undefined;
  
  const rawToolName = toolCall.function_name;
  const IconComponent = getToolIcon(rawToolName);
  const effectiveSandboxId = sandboxId || project?.sandbox?.id;

  return (
    <div className="my-1.5 space-y-2">
      {/* Tool button - exactly like regular tools */}
      <button
        onClick={onToolClick}
        className="inline-flex items-center gap-1.5 h-8 px-2 py-1.5 text-xs text-muted-foreground bg-card hover:bg-card/80 rounded-lg transition-colors cursor-pointer border border-neutral-200 dark:border-neutral-700/50 max-w-full"
      >
        <AppIcon toolCall={toolCall} size={14} className="h-3.5 w-3.5 text-muted-foreground shrink-0" fallbackIcon={IconComponent} />
        <span className="font-mono text-xs text-foreground truncate">Generate Media</span>
        {!isComplete && <KortixLoader size="small" className="ml-1" />}
      </button>

      {/* Media below - image or video */}
      {!isComplete ? (
        <ShimmerBox aspectVideo={isVideoGeneration} />
      ) : media?.type === 'video' ? (
        <InlineVideo filePath={media.path} sandboxId={effectiveSandboxId} />
      ) : media?.type === 'image' ? (
        <InlineImage filePath={media.path} sandboxId={effectiveSandboxId} />
      ) : null}
    </div>
  );
}
