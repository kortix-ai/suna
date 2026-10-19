'use client';

import { useOpenedOnce } from '@/hooks/utils/use-opened-once';
import { lazyClient } from '@kortix/ui/lib/lazy-client';
import type { SubSessionModalProps } from './sub-session-modal-content';

// The body mounts a full read-only `SessionChat` (composer, model gate,
// provider modal, …). Tool rows render this modal closed on every transcript,
// including the marketing home demo, so the body loads on first open only.
const SubSessionModalContent = lazyClient(() =>
  import('./sub-session-modal-content').then((mod) => mod.SubSessionModalContent),
);

export function SubSessionModal(props: SubSessionModalProps) {
  const opened = useOpenedOnce(props.open);
  if (!opened) return null;
  return <SubSessionModalContent {...props} />;
}
