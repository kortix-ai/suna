'use client';
import { TextShimmer } from '@/components/ui/text-shimmer';
import {
  BasicTool,
  isErrorOutput,
  partInput,
  partOutput,
  ToolOutputFallback,
} from '@/features/session/tool/shared/infrastructure';
import { OutputBlock } from '@/features/session/tool/shared/output-block';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
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
      <div className="p-2">
        {isError ? (
          <ToolOutputFallback output={output} toolName="connector_setup" />
        ) : output ? (
          <div className="space-y-1">
            {data?.connectors.map((conn, i) => (
              <div key={i} className="flex items-center gap-2 py-1 text-xs">
                <Plug className="text-muted-foreground size-3.5 flex-shrink-0" />
                <span className="font-medium">{conn}</span>
              </div>
            ))}
            {!data && <OutputBlock text={output} />}
          </div>
        ) : (
          <div className="p-3">
            <TextShimmer>
              {tHardcodedUi.raw(
                'componentsSessionToolRenderers.line7398JsxTextSettingUpConnectors',
              )}
            </TextShimmer>
          </div>
        )}
      </div>
    </BasicTool>
  );
}
ToolRegistry.register('connector_setup', ConnectorSetupTool);
ToolRegistry.register('connector-setup', ConnectorSetupTool);
ToolRegistry.register('oc-connector_setup', ConnectorSetupTool);
ToolRegistry.register('oc-connector-setup', ConnectorSetupTool);
