/**
 * `get_mem` — port of apps/web `tool/tools/get-mem-tool.tsx`.
 *
 * The shut row names the memory ("Recalled · <title or caption>", the record
 * id as the badge; web draws the badge on its panel surface only). Open, the
 * card shows the memory itself — an observation's title and narrative, an LTM
 * entry's caption and content — while its provenance (request, facts,
 * concepts, files read, tags) folds.
 *
 * `GetMemExpandedContent` is the previous mobile body, still imported by
 * `tool-part-renderer.tsx`'s legacy path; it goes when that path is removed.
 */

import { useContext, useMemo, type ReactNode } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import type { ToolPart } from '@/lib/opencode/types';
import { BrainIcon, CalendarDotsIcon, FingerprintIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { isToolStreaming } from '@/lib/session/tools/projects-connectors';
import {
  getMemFactsLabel,
  getMemFilesReadLabel,
  getMemTagsLabel,
  getMemTrigger,
} from '@/lib/session/tools/projects-memory';
import { parseMemoryEntryOutput } from '@/lib/session/tools/projects-memory-entry-output';
import { webSpace } from '@/lib/session/user-message';
import { withAlpha } from '@/lib/utils/theme';
import {
  BasicTool,
  partInput,
  partOutput,
  partStatus,
  ToolEmptyState,
  ToolOutputFallback,
  ToolRunningContext,
} from '../shared/infrastructure';
import { FoldedSection, MonoBlock, OutputBlock, ToolField, ToolSection } from '../shared/output-block';
import { ToolRegistry } from '../shared/registry';
import { ToolResultCard } from '../shared/result-card';
import { FONT_MEDIUM, TURN_SPACE, TURN_TYPE, monoFont, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';

/** `flex flex-wrap items-center gap-1.5`. */
function WrapRow({ children }: { children: ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: TURN_SPACE.gap1_5 }}>
      {children}
    </View>
  );
}

export function GetMemTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const palette = useTurnPalette();
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const running = useContext(ToolRunningContext);
  const source = (input.source as string) || '';
  const memoryId = input.id != null ? String(input.id) : '';
  const report = useMemo(() => parseMemoryEntryOutput(output), [output]);
  const isStreaming = isToolStreaming(status, running);
  const trigger = getMemTrigger(input, report);

  /** `text-xs font-medium` in `STATUS_TEXT.success` — concepts and tags. */
  const successText = [TURN_TYPE.xs, { fontFamily: FONT_MEDIUM, color: palette.success }];

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={BrainIcon}
      trigger={{ title: trigger.title, subtitle: trigger.subtitle }}
      badge={trigger.badge}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {report ? (
        <ToolResultCard bodyStyle={{ rowGap: webSpace(2.5), padding: webSpace(2) }}>
          {source || memoryId ? (
            <FoldedSection label="Request">
              <WrapRow>
                {source ? <ToolField label="Source" value={source} /> : null}
                {memoryId ? <ToolField label="ID" value={`#${memoryId}`} mono /> : null}
              </WrapRow>
            </FoldedSection>
          ) : null}

          {/* One meta line: id, type, created — each icon sits on its text's line. */}
          <View
            style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: webSpace(2), rowGap: webSpace(1) }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: webSpace(1) }}>
              <FingerprintIcon size={TURN_SPACE.statusIcon} color={palette.mutedForeground} />
              <Text variant="muted" style={[TURN_TYPE.xs, { color: palette.mutedForeground }]}>
                {report.kind === 'observation' ? 'Observation #' : 'LTM #'}
                {report.id}
              </Text>
            </View>
            <Text
              variant="muted"
              style={[TURN_TYPE.xs, { letterSpacing: 0.325, textTransform: 'uppercase', color: palette.mutedForeground }]}
            >
              {report.type}
            </Text>
            {report.created ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: webSpace(1) }}>
                <CalendarDotsIcon size={TURN_SPACE.statusIcon} color={palette.mutedForeground} />
                <Text variant="muted" style={[TURN_TYPE.xs, { color: palette.mutedForeground }]}>
                  {report.created}
                </Text>
              </View>
            ) : null}
          </View>

          {report.kind === 'observation' ? (
            <>
              {report.title ? (
                <Text style={[TURN_TYPE.xs, { fontFamily: FONT_MEDIUM, color: palette.foreground90 }]}>{report.title}</Text>
              ) : null}
              {report.narrative ? (
                <ToolSection label="Narrative">
                  <OutputBlock text={report.narrative} markdown />
                </ToolSection>
              ) : null}
              {report.facts.length > 0 ? (
                <FoldedSection label={getMemFactsLabel(report.facts.length)}>
                  <View style={{ rowGap: webSpace(1) }}>
                    {report.facts.map((fact, index) => (
                      <View
                        key={`${report.id}-${index}`}
                        style={{ flexDirection: 'row', alignItems: 'flex-start', gap: TURN_SPACE.gap1_5 }}
                      >
                        {/* `StatusDot tone="success"`: a `size-2` dot at `mt-[6px]`. */}
                        <View
                          style={{
                            marginTop: 6,
                            width: webSpace(2),
                            height: webSpace(2),
                            borderRadius: webSpace(1),
                            backgroundColor: palette.success,
                          }}
                        />
                        <Text style={[TURN_TYPE.xsRelaxed, { flex: 1, color: palette.foreground90 }]}>{fact}</Text>
                      </View>
                    ))}
                  </View>
                </FoldedSection>
              ) : null}
              {report.concepts.length > 0 ? (
                <FoldedSection label="Concepts">
                  <WrapRow>
                    {report.concepts.map((concept) => (
                      <Text key={concept} style={successText}>
                        {concept}
                      </Text>
                    ))}
                  </WrapRow>
                </FoldedSection>
              ) : null}
              {report.tool || report.prompt || report.session || report.filesRead.length > 0 ? (
                <View style={{ rowGap: TURN_SPACE.gap1_5 }}>
                  <WrapRow>
                    {report.tool ? <ToolField label="Tool" value={report.tool} /> : null}
                    {/* Not a ToolField: the `#` marker belongs to the number, so they sit adjacent. */}
                    {report.prompt ? (
                      <Text variant="muted" style={[TURN_TYPE.xs, { color: palette.muted60 }]}>
                        Prompt #<Text style={[TURN_TYPE.xs, { color: palette.foreground80 }]}>{report.prompt}</Text>
                      </Text>
                    ) : null}
                    {report.session ? <ToolField label="Session" value={report.session} mono /> : null}
                  </WrapRow>
                  {report.filesRead.length > 0 ? (
                    <FoldedSection label={getMemFilesReadLabel(report.filesRead.length)}>
                      <WrapRow>
                        {report.filesRead.map((file) => (
                          <View
                            key={file}
                            style={{
                              minHeight: webSpace(6),
                              justifyContent: 'center',
                              borderWidth: 1,
                              borderColor: withAlpha(palette.border, 0.7),
                              borderRadius: TURN_SPACE.radiusSm,
                              paddingHorizontal: webSpace(2),
                              backgroundColor: palette.background,
                            }}
                          >
                            <Text style={[TURN_TYPE.xs, { fontFamily: monoFont, color: withAlpha(palette.foreground, 0.75) }]}>
                              {file}
                            </Text>
                          </View>
                        ))}
                      </WrapRow>
                    </FoldedSection>
                  ) : null}
                </View>
              ) : null}
            </>
          ) : (
            <>
              {report.caption ? (
                <ToolSection label="Caption">
                  <OutputBlock text={report.caption} markdown />
                </ToolSection>
              ) : null}
              {report.content ? (
                <ToolSection label="Content">
                  <OutputBlock text={report.content} markdown />
                </ToolSection>
              ) : null}
              {report.tags.length > 0 ? (
                <FoldedSection label={getMemTagsLabel(report.tags.length)}>
                  <WrapRow>
                    {report.tags.map((tag) => (
                      <Text key={tag} style={successText}>
                        {tag}
                      </Text>
                    ))}
                  </WrapRow>
                </FoldedSection>
              ) : null}
              {report.session || report.updated ? (
                <WrapRow>
                  {report.session ? <ToolField label="Session" value={report.session} mono /> : null}
                  {report.updated ? <ToolField label="Updated" value={report.updated} /> : null}
                </WrapRow>
              ) : null}
            </>
          )}
        </ToolResultCard>
      ) : output ? (
        <ToolOutputFallback output={output} isStreaming={isStreaming} toolName="get_mem" />
      ) : (
        <ToolResultCard>
          <ToolEmptyState message={isStreaming ? 'Loading memory...' : 'No memory found.'} />
        </ToolResultCard>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('get_mem', GetMemTool);
ToolRegistry.register('get-mem', GetMemTool);
ToolRegistry.register('oc-get_mem', GetMemTool);
ToolRegistry.register('oc-get-mem', GetMemTool);

// ─── Legacy body (tool-part-renderer.tsx generic path) ───────────────────────

/** @deprecated Previous mobile body; `GetMemTool` replaces it. Raw output only. */
export function GetMemExpandedContent({ tool, isDark }: { tool: ToolPart; isDark: boolean }) {
  const output =
    tool.state.status === 'completed' && 'output' in tool.state && tool.state.output ? tool.state.output.trim() : '';
  if (!output) return null;
  return (
    <View style={{ paddingHorizontal: 12, paddingVertical: 10, maxHeight: 250 }}>
      <MonoBlock isDark={isDark} maxLines={30}>
        {output.slice(0, 3000)}
      </MonoBlock>
    </View>
  );
}
