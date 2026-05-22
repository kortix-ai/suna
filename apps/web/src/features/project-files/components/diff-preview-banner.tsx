'use client';

import { AlertCircle, Check, Loader2, Minus } from 'lucide-react';
import { InfoBanner } from '@/components/ui/info-banner';
import type { VersionDiffPreview } from '../api/change-requests';

interface DiffPreviewBannerProps {
  loading: boolean;
  error: Error | null;
  preview: VersionDiffPreview | undefined;
  className?: string;
}

/**
 * Small status row rendered inside the Open-CR dialog to surface the live
 * diff between the two selected versions BEFORE the CR is created. Each state
 * is just an <InfoBanner> with the right tone — no hand-rolled colored boxes:
 *   - loading          → neutral spinner
 *   - nothing to merge → warning, blocks submit (parent gates the button)
 *   - has changes      → success file-count + line summary
 */
export function DiffPreviewBanner({
  loading,
  error,
  preview,
  className,
}: DiffPreviewBannerProps) {
  if (loading) {
    return (
      <InfoBanner tone="neutral" className={className}>
        <span className="flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Calculating the diff…
        </span>
      </InfoBanner>
    );
  }

  if (error) {
    return (
      <InfoBanner
        tone="warning"
        icon={AlertCircle}
        title="Couldn't compute the diff"
        className={className}
      >
        {error.message}
      </InfoBanner>
    );
  }

  if (!preview) return null;

  if (preview.is_same_ref) {
    return (
      <InfoBanner tone="warning" icon={Minus} className={className}>
        Same version on both sides — pick different versions.
      </InfoBanner>
    );
  }

  if (preview.is_up_to_date || preview.files_changed === 0) {
    return (
      <InfoBanner tone="warning" icon={Minus} className={className}>
        No changes between these versions. The source needs to be ahead of the
        target before a change request makes sense.
      </InfoBanner>
    );
  }

  return (
    <InfoBanner tone="success" icon={Check} className={className}>
      {preview.files_changed} file{preview.files_changed === 1 ? '' : 's'} changed{' '}
      <span className="font-semibold text-emerald-600 dark:text-emerald-400">
        +{preview.additions}
      </span>{' '}
      <span className="font-semibold text-red-600 dark:text-red-400">
        −{preview.deletions}
      </span>
    </InfoBanner>
  );
}
