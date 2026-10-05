/**
 * `project_get` / `project_update` — port of apps/web
 * `tool/tools/project-get-tool.tsx`: a `p-2` body with the failure, the raw
 * output block, or a "Loading..." shimmer while the call is live ("No output" once it is not).
 */

import { useMemo } from 'react';
import { View } from 'react-native';
import { TextShimmer } from '@/components/kortix/text-shimmer';
import { FolderIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { projectGetTrigger } from '@/lib/session/tools/projects-projects';
import { webSpace } from '@/lib/session/user-message';
import {
  BasicTool,
  isErrorOutput,
  partInput,
  partOutput,
  ToolEmptyState,
  ToolOutputFallback,
  useToolLive,
} from '../shared/infrastructure';
import { OutputBlock } from '../shared/output-block';
import { ToolRegistry } from '../shared/registry';
import { TURN_TYPE } from '../shared/styles';
import type { ToolProps } from '../shared/types';

export function ProjectGetTool({ part, defaultOpen, forceOpen }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  // `isErrorOutput` trims the whole output and runs `JSON.parse` over it.
  const errored = useMemo(() => isErrorOutput(output), [output]);
  const live = useToolLive();

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={FolderIcon}
      trigger={projectGetTrigger(input)}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
    >
      <View style={{ padding: webSpace(2) }}>
        {errored ? (
          <ToolOutputFallback output={output} toolName="project_get" />
        ) : output ? (
          <OutputBlock text={output} />
        ) : live ? (
          <View style={{ padding: webSpace(3) }}>
            <TextShimmer style={TURN_TYPE.sm}>Loading...</TextShimmer>
          </View>
        ) : (
          // Not in flight (settled, or its turn ended): nothing more will arrive.
          <ToolEmptyState message="No output" />
        )}
      </View>
    </BasicTool>
  );
}
ToolRegistry.register('project-get', ProjectGetTool);
ToolRegistry.register('project-update', ProjectGetTool);
