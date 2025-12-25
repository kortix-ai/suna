import React, { useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';
import { ToolViewProps } from '../types';
import { extractImageEditGenerateData } from './_utils';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { useImageContent } from '@/hooks/files';

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
    <div className="relative w-full aspect-square rounded-lg overflow-hidden border border-neutral-200 dark:border-neutral-700/50">
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
      className="w-full rounded-lg border border-neutral-200 dark:border-neutral-700/50"
    />
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
    error,
    batchResults,
  } = extractImageEditGenerateData(toolCall, toolResult, true);

  const sandboxId = project?.sandbox?.id;
  const imagePath = generatedImagePaths[0];
  const hasError = !!error || (batchResults.length > 0 && !batchResults[0].success && !isStreaming);

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardContent className="p-4">
        {hasError ? (
          /* Error State */
          <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
            <div className="w-16 h-16 rounded-full flex items-center justify-center mb-4 bg-gradient-to-b from-rose-100 to-rose-50 dark:from-rose-800/40 dark:to-rose-900/60">
              <AlertTriangle className="h-8 w-8 text-rose-500 dark:text-rose-400" />
            </div>
            <h3 className="text-base font-medium text-zinc-900 dark:text-zinc-100 mb-2">
              Error Occurred
            </h3>
            <p className="text-sm text-zinc-600 dark:text-zinc-400 max-w-md">
              {error || batchResults[0]?.error || 'An error occurred during processing.'}
            </p>
          </div>
        ) : isStreaming || !imagePath ? (
          /* Loading/Streaming State - Show shimmer */
          <ShimmerBox />
        ) : (
          /* Success State - Show image */
          <ImageDisplay filePath={imagePath} sandboxId={sandboxId} />
        )}
      </CardContent>
    </Card>
  );
}
