'use client';

import { AlertCircle, Check, Loader2, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { VersionDiffPreview } from '../api/change-requests';

interface DiffPreviewBannerProps {
  loading: boolean;
  error: Error | null;
  preview: VersionDiffPreview | undefined;
  className?: string;
}

/**
 * Small status row rendered inside the Open-CR dialog to surface the live
 * diff between the two selected versions BEFORE the CR is created. Three
 * possible states:
 *   - loading        → muted spinner
 *   - nothing to merge → amber "no changes" pill, blocks submit (parent
 *     reads `preview` and gates the button)
 *   - has changes    → green file-count + line summary
 */
export function DiffPreviewBanner({
  loading,
  error,
  preview,
  className,
}: DiffPreviewBannerProps) {
  if (loading) {
    return (
      <div
        className={cn(
          'flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground',
          className,
        )}
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>Calculating the diff…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className={cn(
          'flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400',
          className,
        )}
      >
        <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
        <div>
          <div className="font-medium">Couldn't compute the diff</div>
          <div className="mt-0.5 text-amber-700/80 dark:text-amber-400/80">
            {error.message}
          </div>
        </div>
      </div>
    );
  }

  if (!preview) return null;

  if (preview.is_same_ref) {
    return (
      <div
        className={cn(
          'flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400',
          className,
        )}
      >
        <Minus className="h-3.5 w-3.5 shrink-0" />
        <span>Same version on both sides — pick different versions.</span>
      </div>
    );
  }

  if (preview.is_up_to_date || preview.files_changed === 0) {
    return (
      <div
        className={cn(
          'flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400',
          className,
        )}
      >
        <Minus className="h-3.5 w-3.5 shrink-0" />
        <span>
          No changes between these versions. The source needs to be ahead of
          the target before a change request makes sense.
        </span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400',
        className,
      )}
    >
      <Check className="h-3.5 w-3.5 shrink-0" />
      <span>
        {preview.files_changed} file{preview.files_changed === 1 ? '' : 's'} changed{' '}
        <span className="font-semibold text-emerald-700/90 dark:text-emerald-400/90">
          +{preview.additions}
        </span>{' '}
        <span className="font-semibold text-red-600">−{preview.deletions}</span>
      </span>
    </div>
  );
}
