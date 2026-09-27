/**
 * `triggers` and every `trigger_*` alias — port of apps/web
 * `tool/tools/triggers-tool.tsx`.
 *
 * The trigger (title, subtitle, icon, args) comes from the call's `action`
 * (`triggersRow`). The `p-2` body lists parsed trigger lines (source icon,
 * name, schedule / webhook path in mono, status badge), else the raw output
 * (first 3000 characters), else a loading shimmer. A created trigger's prompt
 * folds under a `border-border/30` rule.
 */

import { useMemo } from 'react';
import { View } from 'react-native';
import { TextShimmer } from '@/components/kortix/text-shimmer';
import { Badge } from '@/components/ui/badge';
import { Text } from '@/components/ui/text';
import {
  ArrowClockwiseIcon,
  CalendarDotsIcon,
  GlobeIcon,
  MonitorPlayIcon,
  PlusIcon,
  ProhibitIcon,
  TrashIcon,
  TreeStructureIcon,
  type AppIcon,
} from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import {
  TRIGGER_PROMPT_SECTION,
  parseTriggerLines,
  triggerLoadingMessage,
  triggerPromptPreview,
  triggerStatusTone,
  triggersRow,
  type TriggerIconKey,
} from '@/lib/session/tools/projects-triggers';
import { webSpace } from '@/lib/session/user-message';
import { BasicTool, isErrorOutput, partInput, partOutput, ToolOutputFallback } from '../shared/infrastructure';
import { FoldedSection, OutputBlock } from '../shared/output-block';
import { ToolRegistry } from '../shared/registry';
import { FONT_MEDIUM, TURN_SPACE, TURN_TYPE, monoFont, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';

const TRIGGER_ICONS: Record<TriggerIconKey, AppIcon> = {
  plus: PlusIcon,
  list: TreeStructureIcon,
  trash: TrashIcon,
  calendar: CalendarDotsIcon,
  refresh: ArrowClockwiseIcon,
  monitor: MonitorPlayIcon,
  ban: ProhibitIcon,
};

/** Web `Badge variant={success | warning | muted} size="sm"`. */
function TriggerStatusBadge({ status }: { status: string }) {
  const palette = useTurnPalette();
  const tone = triggerStatusTone(status);
  if (tone === 'muted') {
    return (
      <Badge variant="secondary">
        <Text style={{ color: palette.mutedForeground }}>{status}</Text>
      </Badge>
    );
  }
  const color = tone === 'success' ? palette.success : palette.warning;
  return (
    <Badge
      variant="outline"
      style={{ borderColor: 'transparent', backgroundColor: tone === 'success' ? palette.successBg : palette.warningBg }}
    >
      <Text style={{ textTransform: 'uppercase', color }}>{status}</Text>
    </Badge>
  );
}

export function TriggersTool({ part, defaultOpen, forceOpen }: ToolProps) {
  const palette = useTurnPalette();
  const input = partInput(part);
  const output = partOutput(part);
  const action = (input.action as string) || 'list';

  const row = useMemo(() => triggersRow(action, input, output), [action, input, output]);
  const triggerLines = useMemo(() => parseTriggerLines(output), [output]);
  // Both scan the whole output; memoised so a streaming list does not re-parse per frame.
  const isError = useMemo(() => isErrorOutput(output), [output]);
  const outputPreview = useMemo(() => output.slice(0, 3000), [output]);
  const prompt = triggerPromptPreview(action, input);

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={TRIGGER_ICONS[row.icon]}
      trigger={{ title: row.title, subtitle: row.subtitle, args: row.args }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
    >
      <View style={{ padding: webSpace(2) }}>
        {isError ? (
          <ToolOutputFallback output={output} toolName="triggers" />
        ) : triggerLines.length > 0 ? (
          <View style={{ rowGap: webSpace(1) }}>
            {triggerLines.map((t, i) =>
              'name' in t ? (
                <View
                  key={`${t.name}|${t.sourceType}:${t.sourceDetail}`}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: TURN_SPACE.gap2,
                    paddingHorizontal: webSpace(1),
                    paddingVertical: webSpace(1),
                  }}
                >
                  {t.sourceType === 'webhook' ? (
                    <GlobeIcon size={TURN_SPACE.statusIcon} color={palette.mutedForeground} />
                  ) : (
                    <CalendarDotsIcon size={TURN_SPACE.statusIcon} color={palette.mutedForeground} />
                  )}
                  <Text numberOfLines={1} style={[TURN_TYPE.xs, { flexShrink: 1, fontFamily: FONT_MEDIUM, color: palette.foreground }]}>
                    {t.name}
                  </Text>
                  <Text
                    variant="muted"
                    numberOfLines={1}
                    style={[TURN_TYPE.xs, { marginLeft: 'auto', flexShrink: 1, fontFamily: monoFont, color: palette.mutedForeground }]}
                  >
                    {t.sourceDetail}
                  </Text>
                  <TriggerStatusBadge status={t.status} />
                </View>
              ) : (
                <Text
                  key={i}
                  variant="muted"
                  selectable
                  style={[TURN_TYPE.xs, { paddingVertical: webSpace(0.5), fontFamily: monoFont, color: palette.mutedForeground }]}
                >
                  {t.raw}
                </Text>
              ),
            )}
          </View>
        ) : output ? (
          <OutputBlock text={outputPreview} />
        ) : (
          <View style={{ padding: webSpace(3) }}>
            <TextShimmer style={TURN_TYPE.sm}>{triggerLoadingMessage(action)}</TextShimmer>
          </View>
        )}

        {/* The answer to "create a trigger" is the trigger; the prompt it runs with folds. */}
        {prompt != null ? (
          <View style={{ marginTop: webSpace(2), paddingTop: webSpace(2), borderTopWidth: 1, borderTopColor: palette.border30 }}>
            <FoldedSection label={TRIGGER_PROMPT_SECTION.label} defaultOpen={!TRIGGER_PROMPT_SECTION.folded}>
              <OutputBlock text={prompt} />
            </FoldedSection>
          </View>
        ) : null}
      </View>
    </BasicTool>
  );
}
ToolRegistry.register('triggers', TriggersTool);
ToolRegistry.register('oc-triggers', TriggersTool);
ToolRegistry.register('trigger_create', TriggersTool);
ToolRegistry.register('trigger-create', TriggersTool);
ToolRegistry.register('oc-trigger_create', TriggersTool);
ToolRegistry.register('oc-trigger-create', TriggersTool);
ToolRegistry.register('trigger_list', TriggersTool);
ToolRegistry.register('trigger-list', TriggersTool);
ToolRegistry.register('oc-trigger_list', TriggersTool);
ToolRegistry.register('oc-trigger-list', TriggersTool);
ToolRegistry.register('trigger_get', TriggersTool);
ToolRegistry.register('trigger-get', TriggersTool);
ToolRegistry.register('oc-trigger_get', TriggersTool);
ToolRegistry.register('oc-trigger-get', TriggersTool);
ToolRegistry.register('trigger_delete', TriggersTool);
ToolRegistry.register('trigger-delete', TriggersTool);
ToolRegistry.register('oc-trigger_delete', TriggersTool);
ToolRegistry.register('oc-trigger-delete', TriggersTool);
ToolRegistry.register('trigger_update', TriggersTool);
ToolRegistry.register('trigger-update', TriggersTool);
ToolRegistry.register('oc-trigger_update', TriggersTool);
ToolRegistry.register('oc-trigger-update', TriggersTool);
ToolRegistry.register('trigger_test', TriggersTool);
ToolRegistry.register('trigger-test', TriggersTool);
ToolRegistry.register('oc-trigger_test', TriggersTool);
ToolRegistry.register('oc-trigger-test', TriggersTool);
ToolRegistry.register('trigger_pause', TriggersTool);
ToolRegistry.register('trigger-pause', TriggersTool);
ToolRegistry.register('oc-trigger_pause', TriggersTool);
ToolRegistry.register('oc-trigger-pause', TriggersTool);
ToolRegistry.register('trigger_resume', TriggersTool);
ToolRegistry.register('trigger-resume', TriggersTool);
ToolRegistry.register('oc-trigger_resume', TriggersTool);
ToolRegistry.register('oc-trigger-resume', TriggersTool);
