'use client';
import {
  BasicTool,
  isErrorOutput,
  partInput,
  partOutput,
  ToolEmptyState,
  ToolOutputFallback,
} from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { ToolResultCard } from '../shared/result-card';
import type { ToolProps } from '../shared/types';
import { PlugIcon as Plug } from '@phosphor-icons/react';
import { useTranslations } from '../../../i18n';
import { useMemo } from 'react';

import { parseConnectorSetupOutput } from '../../../shared/lib/utils/kortix-tool-output';

export function ConnectorSetupTool({ call, defaultOpen, forceOpen }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const input = partInput(call);
  const output = partOutput(call);
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
        title: tHardcodedUi.raw('i18nComplete.text0df337fc286c'),
        subtitle: isError
          ? 'failed'
          : data
            ? `${data.count} connector${data.count !== 1 ? 's' : ''} configured`
            : tHardcodedUi.raw('i18nComplete.texte9d6212ef873'),
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
ToolRegistry.register('connector-setup', ConnectorSetupTool);
