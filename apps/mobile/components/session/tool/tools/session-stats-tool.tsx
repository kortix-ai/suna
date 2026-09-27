/**
 * `session_stats`. Port of apps/web `tool/tools/session-stats-tool.tsx`:
 * `Stack` · "Session Stats"; body is the error fallback or the output as markdown.
 */

import { useMemo } from 'react';
import { StackIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { BasicTool, ToolOutputFallback, isErrorOutput, partOutput } from '../shared/infrastructure';
import { OutputBlock } from '../shared/output-block';
import { ToolRegistry } from '../shared/registry';
import type { ToolProps } from '../shared/types';

const NO_ARGS: string[] = [];

export function SessionStatsTool({ part, defaultOpen, forceOpen }: ToolProps) {
  const output = partOutput(part);
  const outputIsError = useMemo(() => isErrorOutput(output), [output]);

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={StackIcon}
      trigger={{ title: 'Session Stats', subtitle: '', args: NO_ARGS }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
    >
      {outputIsError ? (
        <ToolOutputFallback output={output} toolName="session_stats" />
      ) : output ? (
        <OutputBlock text={output} markdown />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('session_stats', SessionStatsTool);
ToolRegistry.register('session-stats', SessionStatsTool);
ToolRegistry.register('oc-session_stats', SessionStatsTool);
ToolRegistry.register('oc-session-stats', SessionStatsTool);
