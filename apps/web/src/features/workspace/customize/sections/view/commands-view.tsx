'use client';

import {
  type ConfigEntity,
  ConfigEntityView,
} from '@/features/workspace/customize/sections/component/config-entity-view';
import { WORKSPACE_ACTIONS } from '@/lib/workspace-actions';
import { useWorkspaceCan } from '@/lib/use-workspace-can';
import { ProhibitIcon as SquareSlash } from '@phosphor-icons/react';

type Command = ConfigEntity;

export function CommandsView({ workspaceId }: { workspaceId: string }) {
  const canWrite = useWorkspaceCan(workspaceId, WORKSPACE_ACTIONS.WORKSPACE_COMMAND_WRITE).allowed === true;
  return (
    <ConfigEntityView<Command>
      workspaceId={workspaceId}
      kind="command"
      noun="command"
      layout="split"
      canWrite={canWrite}
      title="Commands"
      searchPlaceholder="Search commands"
      emptyIcon={SquareSlash}
      emptyTitle="No commands yet"
      emptyDescription="Create a command to give agents reusable slash actions."
      emptyBodyLabel="Command body is empty. Add the prompt content below the frontmatter."
      select={(config) => config.commands}
      triggerVariant="accent"
      renderTriggerLabel={(command) => `/${command.name}`}
      renderDetailTitle={(command) => (
        <span className="flex items-center gap-1">
          <span className="text-muted-foreground/40">/</span>
          {command.name}
        </span>
      )}
    />
  );
}
