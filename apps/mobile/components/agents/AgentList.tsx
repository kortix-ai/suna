/**
 * Agent List Component - Unified agent list using SelectableListItem
 * 
 * Features:
 * - Consistent agent selection UI
 * - Configurable compact/normal layout
 * - Proper haptic feedback
 * - Accessibility support
 * - Spring animations
 * - Uses unified Avatar and SelectableListItem
 */

import * as React from 'react';
import { SelectableListItem } from '@/components/shared/SelectableListItem';
import { EntityList } from '@/components/shared/EntityList';
import { AgentAvatar } from './AgentAvatar';
import type { Agent } from '@/api/types';

interface AgentListProps {
  agents: Agent[];
  selectedAgentId?: string;
  onAgentPress?: (agent: Agent) => void;
  showChevron?: boolean;
  compact?: boolean;
  isLoading?: boolean;
  error?: Error | null;
}

export function AgentList({
  agents,
  selectedAgentId,
  onAgentPress,
  showChevron = false,
  compact = false,
  isLoading = false,
  error = null,
}: AgentListProps) {
  const avatarSize = compact ? 36 : 48;

  return (
    <EntityList
      entities={agents}
      isLoading={isLoading}
      error={error}
      emptyMessage="No workers available"
      loadingMessage="Loading workers..."
      gap={compact ? 2 : 4}
      renderItem={(agent) => (
        <SelectableListItem
          key={agent.agent_id}
          avatar={<AgentAvatar agent={agent} size={avatarSize} />}
          title={agent.name}
          subtitle={agent.description}
          isSelected={agent.agent_id === selectedAgentId}
          showChevron={showChevron}
          onPress={() => onAgentPress?.(agent)}
          accessibilityLabel={`Select ${agent.name} worker`}
        />
      )}
    />
  );
}
