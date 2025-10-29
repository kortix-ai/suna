import * as React from 'react';
import { AgentDrawer } from '@/components/agents';
import { AttachmentDrawer } from '@/components/attachments';

export interface ChatDrawersProps {
  // Agent drawer
  isAgentDrawerVisible: boolean;
  onCloseAgentDrawer: () => void;
  
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
  isAttachmentDrawerVisible,
  onCloseAttachmentDrawer,
  onTakePicture,
  onChooseImages,
  onChooseFiles,
}: ChatDrawersProps) {
  return (
    <>
      {/* Agent Drawer */}
      <AgentDrawer
        visible={isAgentDrawerVisible}
        onClose={onCloseAgentDrawer}
      />

      {/* Attachment Drawer */}
      <AttachmentDrawer
        visible={isAttachmentDrawerVisible}
        onClose={onCloseAttachmentDrawer}
        onTakePicture={onTakePicture}
        onChooseImages={onChooseImages}
        onChooseFiles={onChooseFiles}
      />
    </>
  );
}

