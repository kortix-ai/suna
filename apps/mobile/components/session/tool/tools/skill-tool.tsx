/**
 * `skill`. Port of apps/web `tool/tools/skill-tool.tsx` — the same disclosure
 * as Read / Edit:
 * - trigger: `FileDashed` · "Skill" · the skill name; tapping the name opens
 *   `SKILL.md` in `FileViewer` (web: the session preview) whenever a document
 *   path resolves (`@kortix/sdk` `skillDocumentPath`);
 * - body: a JSON failure → `ToolOutputFallback`; otherwise the document in a
 *   `ToolMarkdownCard` (frontmatter as a key/value card) and the listed files
 *   in a `ToolResultCard` (`space-y-0.5 px-2 py-1.5`; `FileDashed` `size-3`
 *   `text-muted-foreground/40` · mono `text-xs text-muted-foreground/80`).
 */

import { useCallback, useMemo } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { FileDashedIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { skillBody } from '@/lib/session/tools/web-skill';
import { webSpace } from '@/lib/session/user-message';
import {
  BasicTool,
  ToolMarkdownCard,
  ToolOutputFallback,
  partInput,
  partOutput,
  partStatus,
  useToolNavigation,
} from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { ToolResultCard } from '../shared/result-card';
import { TURN_SPACE, TURN_TYPE, monoFont, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';

export function SkillTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const palette = useTurnPalette();
  const { openFile } = useToolNavigation();
  const input = partInput(part);
  const status = partStatus(part);
  const output = partOutput(part);
  const skill = useMemo(() => skillBody(input, output, status), [input, output, status]);
  const { docPath } = skill;
  const openSkillDoc = useCallback(() => {
    if (docPath) openFile(docPath);
  }, [docPath, openFile]);

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={FileDashedIcon}
      trigger={skill.trigger}
      onSubtitleClick={docPath ? openSkillDoc : undefined}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {skill.failure ? (
        <ToolOutputFallback output={output} toolName="skill" />
      ) : skill.hasBody ? (
        <>
          {skill.document ? <ToolMarkdownCard code={skill.document} /> : null}
          {skill.files.length > 0 ? (
            <ToolResultCard bodyStyle={{ rowGap: webSpace(0.5), paddingHorizontal: webSpace(2), paddingVertical: webSpace(1.5) }}>
              {skill.files.map((file) => (
                <View key={file} style={{ flexDirection: 'row', alignItems: 'center', gap: TURN_SPACE.gap1_5 }}>
                  <FileDashedIcon size={TURN_SPACE.statusIcon} color={palette.muted40} />
                  <Text
                    variant="muted"
                    numberOfLines={1}
                    style={[TURN_TYPE.xs, { flexShrink: 1, fontFamily: monoFont, color: palette.muted80 }]}
                  >
                    {file}
                  </Text>
                </View>
              ))}
            </ToolResultCard>
          ) : null}
        </>
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('skill', SkillTool);
