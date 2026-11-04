'use client';

import { useParams } from 'next/navigation';

import { SpaceFolderView } from '@/features/drives/space-folder-view';
import { useProjectSendGate } from '@/hooks/projects/use-project-send-gate';
import { useFeatureFlag } from '@kortix/sdk/react';
import { MY_KORTIX_AGENT_NAME } from '@kortix/shared';
import { FeatureGateScreen } from '@kortix/ui/customize/shared/feature-gate-screen';
import { SpaceView } from '@kortix/ui/workspace';

/**
 * /projects/[id]/chat — Chat (flag `chat`): the person's chat with
 * Kortix. Every message is a thread; Kortix's newest reply shows under it.
 */
export default function OneChatPage() {
  const { id } = useParams<{ id: string }>();
  const flag = useFeatureFlag(id, 'chat');
  const beforeSend = useProjectSendGate(id);
  if (flag.isLoading) return null;
  if (!flag.enabled) {
    return <FeatureGateScreen featureKey="chat" featureName="Chat" description="Talk to Kortix in one chat: every message is a thread, and Kortix's newest reply shows under it." />;
  }
  return (
    <SpaceView
      projectId={id}
      target={{ kind: 'dm', agentName: MY_KORTIX_AGENT_NAME }}
      beforeSend={beforeSend}
      renderFolder={(folder) => <SpaceFolderView projectId={id} {...folder} />}
      chat
    />
  );
}
