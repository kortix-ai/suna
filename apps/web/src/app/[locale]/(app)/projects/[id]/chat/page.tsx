'use client';

import { useParams } from 'next/navigation';

import { FrontChatView } from '@/features/front-chat/front-chat-view';
import { useFeatureFlag } from '@kortix/sdk/react';
import { FeatureGateScreen } from '@kortix/ui/customize/shared/feature-gate-screen';

/** /projects/[id]/chat — the caller's one front chat with Kortix (flag `infinichat`). */
export default function FrontChatPage() {
  const { id } = useParams<{ id: string }>();
  const flag = useFeatureFlag(id, 'infinichat');
  if (flag.isLoading) return null;
  if (!flag.enabled) {
    return <FeatureGateScreen featureKey="infinichat" featureName="One chat" description="One endless chat with Kortix: you only talk, and the work runs in the background." />;
  }
  return <FrontChatView projectId={id} />;
}
