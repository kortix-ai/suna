'use client';
import { Badge } from '@/components/ui/badge';
import { TextShimmer } from '@/components/ui/text-shimmer';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import {
  BasicTool,
  isErrorOutput,
  ToolOutputFallback,
  partInput,
  partOutput,
} from '@/features/session/tool/shared/infrastructure';
import {
  Plug,
} from 'lucide-react';
import {
  useMemo,
} from 'react';


import {
  type ConnectorEntry,
  parseConnectorListOutput,
} from '@/lib/utils/kortix-tool-output';

export function ConnectorListTool({ part, defaultOpen, forceOpen }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const filter = (input.filter as string) || '';
  const connectors = useMemo(() => parseConnectorListOutput(output || ''), [output]);

  return (
    <BasicTool
      icon={<Plug className="text-muted-foreground size-3.5" />}
      trigger={{
        title: 'Connector List',
        subtitle: filter
          ? `Filter: ${filter}`
          : `${connectors.length} connector${connectors.length !== 1 ? 's' : ''}`,
      }}
      defaultOpen={defaultOpen || connectors.length === 0}
      forceOpen={forceOpen}
    >
      {connectors.length > 0 ? (
        <div className="space-y-1 p-2">
          {connectors.map((conn: ConnectorEntry) => (
            <div
              key={conn.name}
              className="hover:bg-muted/30 flex items-start gap-2 rounded px-2 py-1 text-xs"
            >
              <Plug className="text-muted-foreground mt-0.5 size-3.5 flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-foreground truncate font-medium">{conn.name}</div>
                {conn.description && (
                  <div className="text-muted-foreground/60">{conn.description}</div>
                )}
              </div>
              <Badge variant="outline" className="h-5 flex-shrink-0 py-0 text-xs capitalize">
                {conn.source}
              </Badge>
            </div>
          ))}
        </div>
      ) : isErrorOutput(output) ? (
        <ToolOutputFallback output={output} toolName="connector_list" />
      ) : output ? (
        <div className="text-muted-foreground p-3 text-xs">No connectors found</div>
      ) : (
        <div className="p-3">
          <TextShimmer>Loading...</TextShimmer>
        </div>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('connector_list', ConnectorListTool);
ToolRegistry.register('connector-list', ConnectorListTool);
ToolRegistry.register('oc-connector_list', ConnectorListTool);
ToolRegistry.register('oc-connector-list', ConnectorListTool);

