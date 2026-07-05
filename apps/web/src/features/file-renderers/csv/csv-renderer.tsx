'use client';

import { lazy, Suspense } from 'react';
import { FileSpreadsheet } from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { cn } from '@/lib/utils';

const CsvViewer = lazy(() =>
  import('./csv-viewer').then((m) => ({ default: m.CsvViewer })),
);

export function hasCsvContent(content: string | undefined | null): boolean {
  return Boolean(content && content.trim().length > 0);
}

interface CsvRendererProps {
  content: string;
  className?: string;
  compact?: boolean;
  containerHeight?: number;
}

export function CsvRenderer({ content, className, compact = false, containerHeight }: CsvRendererProps) {
  if (!hasCsvContent(content)) {
    return (
      <div className={cn('flex h-full w-full items-center justify-center', className)}>
        {compact ? (
          <div className="text-sm text-muted-foreground">No data</div>
        ) : (
          <div className="space-y-4 text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-muted">
              <FileSpreadsheet className="h-8 w-8 text-muted-foreground" />
            </div>
            <div>
              <h3 className="text-lg font-medium text-foreground">No data</h3>
              <p className="text-sm text-muted-foreground">This file appears to be empty or invalid.</p>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={cn('h-full w-full', className)}
      style={containerHeight ? { height: containerHeight } : undefined}
    >
      <Suspense
        fallback={
          <div className="flex h-full w-full items-center justify-center">
            <KortixLoader size="medium" />
          </div>
        }
      >
        <CsvViewer
          data={content}
          search={!compact}
          showToolbar={!compact}
          className="h-full"
        />
      </Suspense>
    </div>
  );
}
