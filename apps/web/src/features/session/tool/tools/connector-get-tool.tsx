'use client';

import { Badge } from '@/components/ui/badge';
import {
  BasicTool,
  partInput,
  partOutput,
  ToolEmptyState,
  ToolOutputFallback,
} from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import { ToolResultCard } from '@/features/session/tool/shared/result-card';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { PlugIcon as Plug } from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';
import { useMemo } from 'react';

import { parseConnectorGetOutput } from '@/lib/utils/kortix-tool-output';

export function ConnectorGetTool({ part, defaultOpen, forceOpen }: ToolProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const input = partInput(part);
  const output = partOutput(part);
  const name = (input.name as string) || '';
  const data = useMemo(() => parseConnectorGetOutput(output || ''), [output]);

  return (
    <BasicTool
      icon={<Plug className="text-muted-foreground size-3.5" />}
      trigger={{
        title: data?.name || tI18nComplete.raw('textf51e3554540b'),
        subtitle: name && name !== data?.name ? name : data?.description || 'Fetching...',
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
    >
      {data ? (
        <ToolResultCard bodyClassName="space-y-2 p-2">
          {data.description && (
            <div className="text-muted-foreground mb-1 text-xs">{data.description}</div>
          )}
          <div className="flex gap-2 text-xs">
            <Badge variant="outline" className="h-5 py-0 capitalize">
              {data.source}
            </Badge>
          </div>
          {data.env && (
            <div className="text-xs">
              <span className="text-muted-foreground/60">
                {tI18nComplete.raw('text146cd06d5026')}{' '}
              </span>
              <code className="bg-muted rounded px-1 text-xs">{data.env}</code>
            </div>
          )}
          {data.notes && (
            <div className="text-muted-foreground border-border/30 mt-2 border-t pt-2 text-xs whitespace-pre-wrap">
              {data.notes}
            </div>
          )}
        </ToolResultCard>
      ) : output ? (
        <ToolOutputFallback output={output} toolName="connector_get" />
      ) : (
        <ToolResultCard>
          <ToolEmptyState message={tI18nComplete.raw('text6cd606384bc7')} />
        </ToolResultCard>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('connector_get', ConnectorGetTool);
ToolRegistry.register('connector-get', ConnectorGetTool);
ToolRegistry.register('oc-connector_get', ConnectorGetTool);
ToolRegistry.register('oc-connector-get', ConnectorGetTool);
