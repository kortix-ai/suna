'use client';

import { useTranslations } from 'next-intl';

import {
  Alert,
  AlertContent,
  AlertDescription,
  AlertMedia,
  AlertTitle,
} from '@/components/ui/alert';
import Loading from '@/components/ui/loading';
import { DiffStat } from '@/components/ui/status';
import { MinusIcon, WarningCircleIcon } from '@phosphor-icons/react';
import type { VersionDiffPreview } from '../api/change-requests';

interface DiffPreviewBannerProps {
  loading: boolean;
  error: Error | null;
  preview: VersionDiffPreview | undefined;
  className?: string;
}

/**
 * The live answer to "what would this actually propose?", shown in the
 * Open-a-change dialog under the From / Into pickers. One `Alert` per state:
 *
 *   - comparing        → neutral, spinner
 *   - could not compare → destructive, with the reason
 *   - same version     → warning (defensive; the caller already gates on it)
 *   - nothing to send  → warning, and the parent disables submit
 *   - has changes      → neutral summary
 *
 * Built on `Alert` rather than `InfoBanner` because `InfoBanner`'s tones are
 * mislabelled — its `info` is yellow and its `destructive` is a grey border —
 * and its tinted tones carry a 25% fill with no border at all, so a warning
 * floated as an edgeless orange block. `Alert` is `Item variant="outline"`, so
 * every state keeps a hairline, and its warning fill is 10%.
 *
 * The "has changes" state is deliberately NOT green. It reports a precondition
 * being met, not a success, and the green belongs on the additions — which is
 * what `DiffStat` is for. It used to hand-roll its own `+N` / `−N` spans beside
 * the component that exists to draw exactly that.
 */
export function DiffPreviewBanner({ loading, error, preview, className }: DiffPreviewBannerProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');

  if (loading) {
    return (
      <Alert className={className}>
        <AlertMedia>
          <Loading className="size-4 shrink-0" />
        </AlertMedia>
        <AlertContent>
          <AlertDescription>
            {tHardcodedUi.raw(
              'featuresProjectFilesComponentsDiffPreviewBanner.line33JsxTextCalculatingTheDiff',
            )}
          </AlertDescription>
        </AlertContent>
      </Alert>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive" className={className}>
        <AlertMedia>
          <WarningCircleIcon className="size-4" />
        </AlertMedia>
        <AlertContent>
          <AlertTitle>
            {tHardcodedUi.raw(
              'featuresProjectFilesComponentsDiffPreviewBanner.line44JsxAttrTitleCouldnTComputeTheDiff',
            )}
          </AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </AlertContent>
      </Alert>
    );
  }

  if (!preview) return null;

  if (preview.is_same_ref) {
    return (
      <Alert variant="warning" className={className}>
        <AlertMedia>
          <MinusIcon className="size-4" />
        </AlertMedia>
        <AlertContent>
          <AlertDescription>
            {tHardcodedUi.raw(
              'featuresProjectFilesComponentsDiffPreviewBanner.line57JsxTextSameVersionOnBothSidesPickDifferentVersions',
            )}
          </AlertDescription>
        </AlertContent>
      </Alert>
    );
  }

  if (preview.is_up_to_date || preview.files_changed === 0) {
    return (
      <Alert variant="warning" className={className}>
        <AlertMedia>
          <MinusIcon className="size-4" />
        </AlertMedia>
        <AlertContent>
          <AlertDescription>
            {tHardcodedUi.raw(
              'featuresProjectFilesComponentsDiffPreviewBanner.line65JsxTextNoChangesBetweenTheseVersionsTheSourceNeeds',
            )}
          </AlertDescription>
        </AlertContent>
      </Alert>
    );
  }

  return (
    <Alert className={className}>
      <AlertContent>
        <AlertDescription className="flex items-center gap-2 tabular-nums">
          <span>
            {preview.files_changed} file{preview.files_changed === 1 ? '' : 's'} changed
          </span>
          <DiffStat additions={preview.additions} deletions={preview.deletions} />
        </AlertDescription>
      </AlertContent>
    </Alert>
  );
}
