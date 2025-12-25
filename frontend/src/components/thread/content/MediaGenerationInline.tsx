'use client';

import React, { useMemo } from 'react';
import { CircleDashed } from 'lucide-react';
import { useImageContent } from '@/hooks/files';
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

function extractGeneratedImage(output: string | undefined): string | null {
  if (!output) return null;
  const match = output.match(/Image saved as:\s*([^\s\n]+\.(?:png|jpg|jpeg|webp|gif))/i);
  if (match?.[1]) return match[1].trim();
  const directMatch = output.match(/(generated_image_[a-z0-9]+\.(?:png|jpg|jpeg|webp|gif))/i);
  if (directMatch?.[1]) return directMatch[1].trim();
  return null;
}

const BLOB_COLORS = [
  'from-purple-300/60 to-pink-300/60',
  'from-blue-300/60 to-cyan-300/60',
  'from-emerald-300/60 to-teal-300/60',
  'from-orange-300/60 to-amber-300/60',
  'from-rose-300/60 to-red-300/60',
  'from-indigo-300/60 to-violet-300/60',
];

function ShimmerBox() {
  const colorClass = useMemo(() => BLOB_COLORS[Math.floor(Math.random() * BLOB_COLORS.length)], []);
  
  return (
    <div className="relative w-80 aspect-square rounded-lg overflow-hidden border border-neutral-200 dark:border-neutral-700/50">
      <div className={`absolute inset-0 bg-gradient-to-br ${colorClass} blur-2xl scale-150`} />
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
      className="w-80 rounded-lg border border-neutral-200 dark:border-neutral-700/50"
    />
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
  const imagePath = isComplete ? extractGeneratedImage(toolResult?.output) : null;
  
  const rawToolName = toolCall.function_name;
  const IconComponent = getToolIcon(rawToolName);

  return (
    <div className="my-1.5 space-y-2">
      {/* Tool button - exactly like regular tools */}
      <button
        onClick={onToolClick}
        className="inline-flex items-center gap-1.5 h-8 px-2 py-1.5 text-xs text-muted-foreground bg-card hover:bg-card/80 rounded-lg transition-colors cursor-pointer border border-neutral-200 dark:border-neutral-700/50 whitespace-nowrap"
      >
        <AppIcon toolCall={toolCall} size={14} className="h-3.5 w-3.5 text-muted-foreground shrink-0" fallbackIcon={IconComponent} />
        <span className="font-mono text-xs text-foreground">Generate Media</span>
        {!isComplete && <CircleDashed className="h-3.5 w-3.5 text-muted-foreground shrink-0 animate-spin ml-1" />}
      </button>

      {/* Image below - outside wrapper */}
      {!isComplete ? (
        <ShimmerBox />
      ) : imagePath ? (
        <InlineImage filePath={imagePath} sandboxId={sandboxId || project?.sandbox?.id} />
      ) : null}
    </div>
  );
}
