/**
 * The agent picker: the project's visible agents, with the project default
 * marked. `useSession` already filtered out hidden agents and subagents
 * (`useVisibleAgents`), so every row here is one a user may actually run.
 */

import type { ListItem } from '../../../ui/index.ts';
import { InlinePicker } from './inline-picker.tsx';
import type { ComposerAgent } from './use-composer-selection.ts';

export function agentPickerItems(
  agents: readonly ComposerAgent[],
  selected: string | null,
): ListItem[] {
  return agents.map((agent) => ({
    id: `agent:${agent.name}`,
    label: `${agent.name === selected ? '● ' : '  '}${agent.name}`,
    right: agent.isDefault ? 'default' : (agent.description?.slice(0, 32) ?? ''),
  }));
}

export interface AgentPickerProps {
  agents: readonly ComposerAgent[];
  selected: string | null;
  onPick: (name: string) => void;
  onClose: () => void;
  width: number;
  maxRows?: number;
}

export function AgentPicker({
  agents,
  selected,
  onPick,
  onClose,
  width,
  maxRows,
}: AgentPickerProps) {
  return (
    <InlinePicker
      title="Agent"
      items={agentPickerItems(agents, selected)}
      initialId={selected ? `agent:${selected}` : null}
      width={width}
      maxRows={maxRows}
      onClose={onClose}
      onPick={(item) => onPick(item.id.slice('agent:'.length))}
    />
  );
}
