'use client';

import {
  type ConfigEntity,
  ConfigEntityView,
} from '@/features/workspace/customize/sections/component/config-entity-view';
import { SquareSlash } from 'lucide-react';

type Command = ConfigEntity;

export function CommandsView({ projectId, embedded }: { projectId: string; embedded?: boolean }) {
  return (
    <ConfigEntityView<Command>
      projectId={projectId}
      kind="command"
      noun="command"
      embedded={embedded}
      title="Commands"
      description="Pick a command from the list to preview it, or create a new one."
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
