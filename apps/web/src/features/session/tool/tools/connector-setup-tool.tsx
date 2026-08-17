'use client';
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
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';

import { parseConnectorSetupOutput } from '@/lib/utils/kortix-tool-output';

export function ConnectorSetupTool({ part, defaultOpen, forceOpen }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const input = partInput(part);
  const output = partOutput(part);
  const data = useMemo(() => parseConnectorSetupOutput(output || ''), [output]);
  // `isErrorOutput` trims a copy of the whole output and runs `JSON.parse` over
  // it, and this row asked it twice per render — once for the subtitle, once for
  // the body.
  const isError = useMemo(() => isErrorOutput(output), [output]);

  // Connector names are the row identity — disambiguate a repeated name with
  // an occurrence counter instead of the iteration index.
  const keyedConnectors = useMemo(() => {
    const seen = new Map<string, number>();
    return (data?.connectors ?? []).map((conn) => {
      const n = seen.get(conn) ?? 0;
      seen.set(conn, n + 1);
      return { conn, key: n === 0 ? conn : `${conn}#${n}` };
    });
  }, [data]);

  return (
    <BasicTool
      icon={<Plug className="text-muted-foreground size-3.5" />}
      trigger={{
        title: 'Connected an app',
        subtitle: isError
          ? 'failed'
          : data
            ? `${data.count} connector${data.count !== 1 ? 's' : ''} configured`
            : 'Setting up...',
        args: data?.success ? ['configured'] : undefined,
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
    >
      {isError ? (
        <ToolOutputFallback output={output} toolName="connector_setup" />
      ) : data && data.connectors.length > 0 ? (
        <ToolResultCard bodyClassName="space-y-0.5">
          {keyedConnectors.map(({ conn, key }) => (
            <div key={key} className="flex items-center gap-2 px-2 py-1 text-xs">
              <Plug className="text-muted-foreground size-3.5 shrink-0" />
              <span className="font-medium">{conn}</span>
            </div>
          ))}
        </ToolResultCard>
      ) : output ? (
        <ToolOutputFallback output={output} toolName="connector_setup" />
      ) : (
        <ToolResultCard>
          <ToolEmptyState
            message={tHardcodedUi.raw(
              'componentsSessionToolRenderers.line7398JsxTextSettingUpConnectors',
            )}
          />
        </ToolResultCard>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('connector_setup', ConnectorSetupTool);
ToolRegistry.register('connector-setup', ConnectorSetupTool);
ToolRegistry.register('oc-connector_setup', ConnectorSetupTool);
ToolRegistry.register('oc-connector-setup', ConnectorSetupTool);
