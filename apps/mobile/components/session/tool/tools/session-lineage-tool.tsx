/**
 * `session_lineage`. Port of apps/web `tool/tools/session-lineage-tool.tsx`:
 * `TreeStructure` · "Session history" · the short session id · `N sessions`;
 * body is the error fallback or the output as markdown.
 */

import { useMemo } from 'react';
import { TreeStructureIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { countLineageSessions, shortSessionId } from '@/lib/session/tools/agents-session';
import { BasicTool, ToolOutputFallback, isErrorOutput, partInput, partOutput } from '../shared/infrastructure';
import { OutputBlock } from '../shared/output-block';
import { ToolRegistry } from '../shared/registry';
import type { ToolProps } from '../shared/types';

const NO_ARGS: string[] = [];

export function SessionLineageTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const sessionId = (input.session_id as string) || '';
  const sessionCount = useMemo(() => countLineageSessions(output), [output]);
  const args = useMemo(() => (sessionCount > 0 ? [`${sessionCount} sessions`] : NO_ARGS), [sessionCount]);
  const outputIsError = useMemo(() => isErrorOutput(output), [output]);

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={TreeStructureIcon}
      trigger={{ title: 'Session history', subtitle: shortSessionId(sessionId), args }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {outputIsError ? (
        <ToolOutputFallback output={output} toolName="session_lineage" />
      ) : output ? (
        <OutputBlock text={output} markdown />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('session_lineage', SessionLineageTool);
ToolRegistry.register('session-lineage', SessionLineageTool);
ToolRegistry.register('oc-session_lineage', SessionLineageTool);
ToolRegistry.register('oc-session-lineage', SessionLineageTool);
