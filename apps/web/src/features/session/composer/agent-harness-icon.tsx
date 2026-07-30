'use client';

import { FaviconAvatar, type FaviconAvatarSize } from '@/components/ui/favicon-avatar';
import { cn } from '@/lib/utils';
import type { HarnessId } from '@kortix/shared/harnesses';
import { getAgentHarnessFaviconDomain, getAgentHarnessLabel } from './agent-selector-label';

export function AgentHarnessIcon({
  harness,
  size = '2xs',
  className,
}: {
  harness: HarnessId | null | undefined;
  size?: FaviconAvatarSize;
  className?: string;
}) {
  const domain = getAgentHarnessFaviconDomain(harness);
  const label = getAgentHarnessLabel(harness);

  if (!domain || !label) return null;

  return (
    <span
      role="img"
      aria-label={`${label} harness`}
      data-harness={harness}
      className={cn('inline-flex shrink-0', className)}
    >
      <FaviconAvatar value={domain} size={size} alt="" />
    </span>
  );
}
