'use client';

/**
 * Review Center wired to live data: fetches the project's review items, maps the
 * API rows into the inbox view model, and routes the inbox's actions to the
 * `/act` and `/bulk` mutations. The presentational inbox (review-center.tsx) is
 * shared with the mock prototype. See docs/REVIEW_CENTER_DESIGN.md.
 */

import { errorToast } from '@/components/ui/toast';
import { useMemo } from 'react';
import { useActReviewItem, useBulkActReviewItems, useReviewItems } from './hooks/use-review-items';
import { mapApiReviewItem } from './map';
import { ReviewCenter } from './review-center';

export function ReviewCenterConnected({ projectName }: { projectName: string }) {
  const { data, isLoading } = useReviewItems();
  const act = useActReviewItem();
  const bulk = useBulkActReviewItems();

  const items = useMemo(
    () => (data?.review_items ?? []).map((row) => mapApiReviewItem(row, projectName)),
    [data, projectName],
  );

  return (
    <ReviewCenter
      initialItems={items}
      isLoading={isLoading}
      onAct={(id, verdict, feedback) =>
        act.mutate({ id, verdict, feedback }, { onError: (e) => errorToast(e.message) })
      }
      onBulkAct={(ids, verdict) =>
        bulk.mutate({ ids, verdict }, { onError: (e) => errorToast(e.message) })
      }
    />
  );
}
