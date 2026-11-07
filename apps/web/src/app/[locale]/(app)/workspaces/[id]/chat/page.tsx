'use client';

import { useParams } from 'next/navigation';

import { useTranslations } from '@/i18n/use-translations';

import { SpaceFileView } from '@/features/drives/space-file-view';
import { SpaceFolderView } from '@/features/drives/space-folder-view';
import { useProjectSendGate } from '@/hooks/projects/use-project-send-gate';
import { useFeatureFlag } from '@kortix/sdk/react';
import { MY_KORTIX_AGENT_NAME } from '@kortix/shared';
import { FeatureGateScreen } from '@kortix/ui/customize/shared/feature-gate-screen';
import { SpaceView } from '@kortix/ui/workspace';

/**
 * /workspaces/[id]/chat — Chat (flag `chat`): the person's chat with
 * Kortix. Every message is a thread; Kortix's newest reply shows under it.
 */
export default function OneChatPage() {
  const { id } = useParams<{ id: string }>();
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const flag = useFeatureFlag(id, 'chat');
  const beforeSend = useProjectSendGate(id);
  if (flag.isLoading) return null;
  if (!flag.enabled) {
    return <FeatureGateScreen featureKey="chat" featureName="Chat" description={tI18nComplete.raw('textfe0dab79db43')} />;
  }
  return (
    <SpaceView
      projectId={id}
      target={{ kind: 'dm', agentName: MY_KORTIX_AGENT_NAME }}
      beforeSend={beforeSend}
      renderFolder={(folder) => <SpaceFolderView projectId={id} {...folder} />}
      renderFile={(file) => <SpaceFileView projectId={id} {...file} />}
      chat
    />
  );
}
