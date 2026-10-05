'use client';
import {
  BasicTool,
  ToolOutputFallback,
  partOutput,
  partStatus,
} from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import { ToolResultCard } from '@/features/session/tool/shared/result-card';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { PlugIcon as Plug } from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';

export function RemovedConnectorTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const output = partOutput(part);

  return (
    <BasicTool
      icon={<Plug className="size-3.5 shrink-0" />}
      trigger={
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="text-foreground text-xs font-medium whitespace-nowrap">
            {tHardcodedUi.raw('componentsSessionToolRenderers.line5270JsxTextLegacyConnectorTool')}
          </span>
          <span className="text-muted-foreground/60 ml-auto text-xs font-medium whitespace-nowrap">
            {tHardcodedUi.raw('i18nComplete.texte1f79758cc42')}
          </span>
        </div>
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      <>
        <ToolResultCard bodyClassName="px-2 py-1.5">
          <p className="text-muted-foreground text-xs leading-relaxed">
            {tHardcodedUi.raw(
              'componentsSessionToolRenderers.line5283JsxTextThisLegacyConnectorToolSurfaceHasBeenRemoved',
            )}
          </p>
        </ToolResultCard>
        {output ? (
          <ToolOutputFallback
            output={output}
            isStreaming={partStatus(part) === 'running'}
            toolName="legacy-integration"
          />
        ) : null}
      </>
    </BasicTool>
  );
}
[
  'integration-list',
  'integration-connect',
  'integration-search',
  'integration-actions',
  'integration-run',
  'integration-request',
  'integration-exec',
].forEach((toolName) => ToolRegistry.register(toolName, RemovedConnectorTool));
