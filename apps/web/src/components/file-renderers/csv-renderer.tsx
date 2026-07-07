'use client';

import { CsvViewer } from '@/components/ui/extend/csv-viewer';
import { cn } from '@/lib/utils';

interface CsvRendererProps {
  /** Raw CSV/TSV text — delimiter is auto-detected. */
  content: string;
  className?: string;
  /** Compact mode for inline previews — hides the search toolbar */
  compact?: boolean;
}

export function CsvRenderer({ content, className, compact = false }: CsvRendererProps) {
  return (
    <div className={cn('h-full w-full', className)}>
      <CsvViewer data={content} search={!compact} className="h-full" />
    </div>
  );
}
