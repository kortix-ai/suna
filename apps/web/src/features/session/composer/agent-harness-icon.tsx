'use client';

import { FaviconAvatar, type FaviconAvatarSize } from '@/components/ui/favicon-avatar';
import { useMultiHarnessEnabled } from '@/hooks/projects/use-multi-harness-enabled';
import { cn } from '@/lib/utils';
import type { HarnessId } from '@kortix/shared/harnesses';
import { getAgentHarnessFaviconDomain, getAgentHarnessLabel } from './agent-selector-label';

/**
 * The harness badge on an agent row. It exists ONLY to tell two harnesses
 * apart, so it renders only where more than one harness can run: projects with
 * the `acp_runtime` experiment on. With the experiment off every session runs
 * `opencode` over REST, which makes the badge a constant that labels nothing —
 * and a v3 manifest declaring `harness: claude` would advertise a harness the
 * API refuses to launch (409 `HARNESS_NOT_ENABLED`).
 *
 * `projectId` is a required prop rather than optional: defaulting it would make
 * "no project in scope" silently render the badge-less path, which reads
 * identically to a correct gate and hides a wiring mistake.
 */
export function AgentHarnessIcon({
  projectId,
  harness,
  size = '2xs',
  className,
}: {
  projectId: string | undefined;
  harness: HarnessId | null | undefined;
  size?: FaviconAvatarSize;
  className?: string;
}) {
  const multiHarnessEnabled = useMultiHarnessEnabled(projectId);
  const domain = getAgentHarnessFaviconDomain(harness);
  const label = getAgentHarnessLabel(harness);

  if (!multiHarnessEnabled || !domain || !label) return null;

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
