'use client';

import {
  BasicTool,
  isErrorOutput,
  partInput,
  partOutput,
  partStatus,
  ToolOutputFallback,
} from '@/features/session/tool/shared/infrastructure';
import { OutputBlock } from '@/features/session/tool/shared/output-block';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { CpuIcon as Cpu } from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';
import { useMemo } from 'react';

export function VideoGenTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const prompt = input.prompt as string | undefined;
  // `isErrorOutput` trims the whole output and attempts a `JSON.parse` over it.
  // The generator returns a JSON envelope, so that parse actually succeeds and
  // builds an object graph — once per render, from inside the JSX.
  const isError = useMemo(() => isErrorOutput(output), [output]);

  return (
    <BasicTool
      icon={<Cpu className="size-3.5 shrink-0" />}
      trigger={{ title: tI18nComplete.raw('textd534be829e32'), subtitle: prompt?.slice(0, 60) }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {isError ? (
        <ToolOutputFallback output={output} toolName="video_gen" />
      ) : output ? (
        <div className="p-2">
          <OutputBlock text={output} />
        </div>
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('video-gen', VideoGenTool);
