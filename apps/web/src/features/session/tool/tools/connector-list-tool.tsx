'use client';
import { Badge } from '@/components/ui/badge';
import {
  BasicTool,
  isErrorOutput,
  partInput,
  partOutput,
  ToolEmptyState,
  ToolOutputFallback,
} from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import { ToolResultCard } from '@/features/session/tool/shared/result-card';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { PlugIcon as Plug } from '@phosphor-icons/react';
import { useMemo } from 'react';

import { type ConnectorEntry, parseConnectorListOutput } from '@/lib/utils/kortix-tool-output';

export function ConnectorListTool({ part, defaultOpen, forceOpen }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const filter = (input.filter as string) || '';
  const connectors = useMemo(() => parseConnectorListOutput(output || ''), [output]);
  // `isErrorOutput` trims a copy of the whole output and runs `JSON.parse` over
  // it. Called from the render body it did that on every frame of the stream.
  const isError = useMemo(() => isErrorOutput(output), [output]);

  return (
    <BasicTool
      icon={<Plug className="text-muted-foreground size-3.5" />}
      trigger={{
        title: 'Connected apps',
        subtitle: filter
          ? `Filter: ${filter}`
          : `${connectors.length} connector${connectors.length !== 1 ? 's' : ''}`,
      }}
      defaultOpen={defaultOpen || connectors.length === 0}
      forceOpen={forceOpen}
    >
      {connectors.length > 0 ? (
        <ToolResultCard bodyClassName="space-y-1">
          {connectors.map((conn: ConnectorEntry) => (
            <div
              key={conn.name}
              className="hover:bg-muted/30 flex items-start gap-2 rounded px-2 py-1 text-xs"
            >
              <Plug className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-foreground truncate font-medium">{conn.name}</div>
                {conn.description && (
                  <div className="text-muted-foreground/60">{conn.description}</div>
                )}
              </div>
              <Badge variant="outline" className="h-5 shrink-0 py-0 text-xs capitalize">
                {conn.source}
              </Badge>
            </div>
          ))}
        </ToolResultCard>
      ) : isError ? (
        <ToolOutputFallback output={output} toolName="connector_list" />
      ) : output ? (
        <ToolResultCard>
          <ToolEmptyState message="No connectors found." />
        </ToolResultCard>
      ) : (
        <ToolResultCard>
          <ToolEmptyState message="Loading connectors…" />
        </ToolResultCard>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('connector_list', ConnectorListTool);
ToolRegistry.register('connector-list', ConnectorListTool);
ToolRegistry.register('oc-connector_list', ConnectorListTool);
ToolRegistry.register('oc-connector-list', ConnectorListTool);
