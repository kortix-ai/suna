/**
 * `project_list` — port of apps/web `tool/tools/project-list-tool.tsx`: one
 * line per project (`text-muted-foreground/70 gap-1.5 py-0.5 text-xs`, a
 * `size-3.5` folder at `/50`, the name, the path in mono at `/40`), else the
 * raw output capped at 2000 characters. Opens by default when nothing parsed.
 */

import { useMemo } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { FolderIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { projectListSubtitle } from '@/lib/session/tools/projects-projects';
import { parseProjectListOutput } from '@/lib/session/tools/projects-tool-output';
import { webSpace } from '@/lib/session/user-message';
import { BasicTool, isErrorOutput, partOutput, ToolOutputFallback } from '../shared/infrastructure';
import { OutputBlock } from '../shared/output-block';
import { ToolRegistry } from '../shared/registry';
import { TURN_SPACE, TURN_TYPE, monoFont, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';

export function ProjectListTool({ part, defaultOpen, forceOpen }: ToolProps) {
  const palette = useTurnPalette();
  const output = partOutput(part);
  const projects = useMemo(() => parseProjectListOutput(output || ''), [output]);
  // `isErrorOutput` trims the whole output and runs `JSON.parse` over it.
  const errored = useMemo(() => isErrorOutput(output), [output]);

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={FolderIcon}
      trigger={{ title: 'Workspace', subtitle: projectListSubtitle(projects.length) }}
      defaultOpen={defaultOpen || projects.length === 0}
      forceOpen={forceOpen}
    >
      {errored ? (
        <ToolOutputFallback output={output} toolName="project_list" />
      ) : projects.length > 0 ? (
        <View style={{ rowGap: webSpace(0.5) }}>
          {projects.map((project) => (
            <View
              key={project.path}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: TURN_SPACE.gap1_5,
                paddingVertical: TURN_SPACE.rowPadY,
              }}
            >
              <FolderIcon size={TURN_SPACE.caret} color={palette.muted50} />
              <Text variant="muted" numberOfLines={1} style={[TURN_TYPE.xs, { flexShrink: 1, color: palette.muted70 }]}>
                {project.name}
              </Text>
              <Text
                variant="muted"
                numberOfLines={1}
                style={[TURN_TYPE.xs, { flexShrink: 1, fontFamily: monoFont, color: palette.muted40 }]}
              >
                {project.path}
              </Text>
            </View>
          ))}
        </View>
      ) : output ? (
        <OutputBlock text={output.slice(0, 2000)} />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('project_list', ProjectListTool);
ToolRegistry.register('project-list', ProjectListTool);
ToolRegistry.register('oc-project_list', ProjectListTool);
ToolRegistry.register('oc-project-list', ProjectListTool);
