'use client';

import { KortixLoader } from '@/components/ui/kortix-loader';
import { cn } from '@/lib/utils';
import { FileSpreadsheet } from 'lucide-react';
import { lazy, Suspense } from 'react';

const CsvViewer = lazy(() => import('./csv-viewer').then((m) => ({ default: m.CsvViewer })));

export function hasCsvContent(content: string | undefined | null): boolean {
  return Boolean(content && content.trim().length > 0);
}

interface CsvRendererProps {
  content: string;
  className?: string;
  compact?: boolean;
  containerHeight?: number;
  fileName?: string;
  /** Extra controls for this viewer's own toolbar. */
  toolbarActions?: React.ReactNode;
}

export function CsvRenderer({
  content,
  className,
  compact = false,
  containerHeight,
  fileName,
  toolbarActions,
}: CsvRendererProps) {
  if (!hasCsvContent(content)) {
    return (
      <div className={cn('flex h-full w-full items-center justify-center', className)}>
        {compact ? (
          <div className="text-muted-foreground text-sm">No data</div>
        ) : (
          <div className="space-y-4 text-center">
            <div className="bg-muted mx-auto flex h-16 w-16 items-center justify-center rounded-full">
              <FileSpreadsheet className="text-muted-foreground h-8 w-8" />
            </div>
            <div>
              <h3 className="text-foreground text-lg font-medium">No data</h3>
              <p className="text-muted-foreground text-sm">
                This file appears to be empty or invalid.
              </p>
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
          fileName={fileName}
          search={!compact}
          showToolbar={!compact}
          toolbarActions={toolbarActions}
          className="h-full"
        />
      </Suspense>
    </div>
  );
}
