/**
 * Legacy call shape (`text` + `size`) for `TextShimmer`. Kept for importers
 * that still use it (`SessionTurn.tsx`, `tool/tools/show-tool.tsx`); new code
 * imports `TextShimmer` from `@/components/kortix/text-shimmer` directly.
 */

import { TextShimmer } from '@/components/kortix/text-shimmer';
import { TURN_TYPE } from '@/components/session/tool/shared/styles';

export function ShimmerStatusText({ text, size = 'sm' }: { text: string; size?: 'sm' | 'xs' }) {
  return (
    <TextShimmer style={size === 'xs' ? TURN_TYPE.xs : TURN_TYPE.sm} numberOfLines={1}>
      {text}
    </TextShimmer>
  );
}
