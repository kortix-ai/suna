import * as React from 'react';
import { AgentDrawer } from '@/components/agents';
import { AttachmentDrawer } from '@/components/attachments';
import { WorkerConfigDrawer } from '@/components/workers/WorkerConfigDrawer';

export interface ChatDrawersProps {
  // Agent drawer
  isAgentDrawerVisible: boolean;
  onCloseAgentDrawer: () => void;
  onOpenWorkerConfig?: (
    workerId: string,
    view?: 'instructions' | 'tools' | 'integrations' | 'triggers'
  ) => void;
  onAgentDrawerDismiss?: () => void;

  // Worker config drawer
  isWorkerConfigDrawerVisible: boolean;
  workerConfigWorkerId: string | null;
  workerConfigInitialView?: 'instructions' | 'tools' | 'integrations' | 'triggers';
  onCloseWorkerConfigDrawer: () => void;
  onWorkerUpdated?: () => void;
  onUpgradePress?: () => void;

  // Attachment drawer
  isAttachmentDrawerVisible: boolean;
  onCloseAttachmentDrawer: () => void;
  onTakePicture: () => Promise<void>;
  onChooseImages: () => Promise<void>;
  onChooseFiles: () => Promise<void>;
}

/**
 * ChatDrawers Component
 *
 * Shared drawer components for HomePage and ThreadPage:
 * - AgentDrawer: Agent selection
 * - AttachmentDrawer: Photo/file attachment options
 *
 * This component extracts common drawer management from both page components.
 */
export function ChatDrawers({
  isAgentDrawerVisible,
  onCloseAgentDrawer,
  onOpenWorkerConfig,
  onAgentDrawerDismiss,
  isWorkerConfigDrawerVisible,
  workerConfigWorkerId,
  workerConfigInitialView,
  onCloseWorkerConfigDrawer,
  onWorkerUpdated,
  onUpgradePress,
  isAttachmentDrawerVisible,
  onCloseAttachmentDrawer,
  onTakePicture,
  onChooseImages,
  onChooseFiles,
}: ChatDrawersProps) {
  return (
    <>
      {isAgentDrawerVisible && (
        <AgentDrawer
          visible={isAgentDrawerVisible}
          onClose={onCloseAgentDrawer}
          onOpenWorkerConfig={onOpenWorkerConfig}
          onDismiss={onAgentDrawerDismiss}
        />
      )}

      {isWorkerConfigDrawerVisible && workerConfigWorkerId && (
        <WorkerConfigDrawer
          visible={isWorkerConfigDrawerVisible}
          workerId={workerConfigWorkerId}
          onClose={onCloseWorkerConfigDrawer}
          onWorkerUpdated={onWorkerUpdated}
          initialView={workerConfigInitialView}
          onUpgradePress={onUpgradePress}
        />
      )}

      {isAttachmentDrawerVisible && (
        <AttachmentDrawer
          visible={isAttachmentDrawerVisible}
          onClose={onCloseAttachmentDrawer}
          onTakePicture={onTakePicture}
          onChooseImages={onChooseImages}
          onChooseFiles={onChooseFiles}
        />
      )}
    </>
  );
}
