import React from 'react';
import { ComposioRegistry } from './composio/composio-registry';

interface IntegrationsRegistryProps {
  showAgentSelector?: boolean;
  selectedAgentId?: string;
  onAgentChange?: (agentId: string | undefined) => void;
  onToolsSelected?: (profileId: string, selectedTools: string[], appName: string, appSlug: string) => void;
  onClose?: () => void;
  initialSelectedApp?: string | null;
  isBlocked?: boolean;
  onBlockedClick?: () => void;
}

export const IntegrationsRegistry: React.FC<IntegrationsRegistryProps> = ({
  showAgentSelector = true,
  selectedAgentId,
  onAgentChange,
  onToolsSelected,
  onClose,
  initialSelectedApp,
  isBlocked,
  onBlockedClick,
}) => {
  return (
    <ComposioRegistry
      showAgentSelector={showAgentSelector}
      selectedAgentId={selectedAgentId}
      onAgentChange={onAgentChange}
      onToolsSelected={onToolsSelected}
      onClose={onClose}
      initialSelectedApp={initialSelectedApp}
      isBlocked={isBlocked}
      onBlockedClick={onBlockedClick}
    />
  );
}; 