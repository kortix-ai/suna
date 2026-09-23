/**
 * The `kortix-connectors_*` tools — port of apps/web
 * `tool/tools/connector-tools.tsx`: `connectors` (the list), `discover`
 * (action search), `describe` (one action and its schema), `call` (one
 * connector call and its result).
 *
 * The status line and the RESULT stay open; the JSON that went in (request
 * arguments, input schema) folds. The fold decisions are
 * `CONNECTOR_CALL_SECTIONS` / `CONNECTOR_DESCRIBE_SCHEMA_SECTION`.
 */

import { useContext, useMemo, type ReactNode } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { CodeSimpleIcon, MagnifyingGlassIcon, PlugIcon, TerminalWindowIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import {
  CONNECTOR_CALL_SECTIONS,
  CONNECTOR_DESCRIBE_SCHEMA_SECTION,
  connectorCallView,
  connectorDescribeView,
  connectorDiscoverEmptyMessage,
  connectorDiscoverTrigger,
  connectorRowKey,
  connectorsTrigger,
  isToolStreaming,
  type ConnectorSection,
  type ConnectorTone,
} from '@/lib/session/tools/projects-connectors';
import { webSpace } from '@/lib/session/user-message';
import { ConnectorJson, ConnectorRiskBadge, parseConnectorOutput } from '../shared/error-and-connector';
import {
  BasicTool,
  isErrorOutput,
  partInput,
  partOutput,
  partStatus,
  ToolEmptyState,
  ToolOutputFallback,
  ToolRunningContext,
} from '../shared/infrastructure';
import { FoldedSection, ToolSection } from '../shared/output-block';
import { ToolRegistry } from '../shared/registry';
import { ToolResultCard } from '../shared/result-card';
import { FONT_MEDIUM, FONT_SEMIBOLD, TURN_SPACE, TURN_TYPE, monoFont, useTurnPalette, type TurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';

/** Shared empty list: a fresh `[]` per render would re-render every row. */
const EMPTY_ROWS = Object.freeze([]) as readonly Record<string, unknown>[];

function toneColor(palette: TurnPalette, tone: ConnectorTone): string {
  return tone === 'success' ? palette.success : tone === 'warning' ? palette.warning : palette.destructive;
}

/** `text-[10px] font-semibold uppercase`. */
function StatusLabel({ children, color, style }: { children: string; color: string; style?: object }) {
  return (
    <Text
      variant="small"
      style={[TURN_TYPE.label10, { flexShrink: 0, fontFamily: FONT_SEMIBOLD, letterSpacing: 0, textTransform: 'uppercase', color }, style]}
    >
      {children}
    </Text>
  );
}

/** A labelled body section: folded (`FoldedSection`) or open (`ToolSection`). */
function Section({ section, children }: { section: ConnectorSection; children: ReactNode }) {
  return section.folded ? (
    <FoldedSection label={section.label}>{children}</FoldedSection>
  ) : (
    <ToolSection label={section.label}>{children}</ToolSection>
  );
}

// ─── connectors ──────────────────────────────────────────────────────────────

export function ConnectorsTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const palette = useTurnPalette();
  const output = partOutput(part);
  const status = partStatus(part);
  const running = useContext(ToolRunningContext);
  const parsed = useMemo(() => parseConnectorOutput(output), [output]);
  const connectors = (Array.isArray(parsed?.connectors) ? parsed.connectors : EMPTY_ROWS) as Record<string, unknown>[];
  const isStreaming = isToolStreaming(status, running);

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={PlugIcon}
      trigger={connectorsTrigger(status, connectors.length)}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {connectors.length > 0 ? (
        <ToolResultCard bodyStyle={{ rowGap: webSpace(0.5) }}>
          {connectors.map((c) => (
            <View
              key={connectorRowKey(c)}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: TURN_SPACE.gap2,
                paddingHorizontal: webSpace(2),
                paddingVertical: webSpace(1),
              }}
            >
              <PlugIcon size={TURN_SPACE.statusIcon} color={palette.muted50} />
              <Text numberOfLines={1} style={[TURN_TYPE.xs, { flexShrink: 1, fontFamily: FONT_MEDIUM, color: palette.foreground }]}>
                {String(c.name || c.slug || '')}
              </Text>
              <Text variant="muted" style={[TURN_TYPE.xs, { fontFamily: monoFont, color: palette.muted60 }]}>
                {String(c.provider ?? '')}
              </Text>
              <Text variant="muted" style={[TURN_TYPE.xs, { marginLeft: 'auto', color: palette.muted50 }]}>
                {String(c.tools ?? 0)} tools
              </Text>
              <StatusLabel color={c.status === 'active' ? palette.success : palette.muted60}>
                {String(c.status ?? '')}
              </StatusLabel>
            </View>
          ))}
        </ToolResultCard>
      ) : output ? (
        <ToolOutputFallback output={output} isStreaming={isStreaming} toolName="connectors" />
      ) : (
        <ToolResultCard>
          <ToolEmptyState message={isStreaming ? 'Loading connectors…' : 'No connectors.'} />
        </ToolResultCard>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('kortix-connectors_connectors', ConnectorsTool);

// ─── discover ────────────────────────────────────────────────────────────────

export function ConnectorDiscoverTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const palette = useTurnPalette();
  const input = partInput(part);
  const output = partOutput(part);
  const outputIsError = useMemo(() => isErrorOutput(output), [output]);
  const status = partStatus(part);
  const running = useContext(ToolRunningContext);
  const parsed = useMemo(() => parseConnectorOutput(output), [output]);
  const matches = (Array.isArray(parsed?.matches) ? parsed.matches : EMPTY_ROWS) as Record<string, unknown>[];
  const trigger = connectorDiscoverTrigger(input, status, matches.length);
  const query = trigger.subtitle ?? '';
  const isStreaming = isToolStreaming(status, running);

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={MagnifyingGlassIcon}
      trigger={trigger}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {outputIsError ? (
        <ToolOutputFallback output={output} isStreaming={isStreaming} toolName="discover" />
      ) : matches.length > 0 ? (
        <ToolResultCard bodyStyle={{ rowGap: webSpace(1.5) }}>
          {matches.map((m) => (
            <View
              key={String(m.tool ?? '') || String(m.description ?? '').slice(0, 60)}
              style={{ paddingHorizontal: webSpace(2), paddingVertical: webSpace(1) }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: TURN_SPACE.gap2 }}>
                <Text numberOfLines={1} style={[TURN_TYPE.xs, { flexShrink: 1, fontFamily: monoFont, color: palette.foreground }]}>
                  {String(m.tool ?? '')}
                </Text>
                <ConnectorRiskBadge risk={m.risk} />
              </View>
              {m.description ? (
                <Text
                  variant="muted"
                  numberOfLines={2}
                  style={[TURN_TYPE.xsRelaxed, { marginTop: webSpace(0.5), color: palette.mutedForeground }]}
                >
                  {String(m.description)}
                </Text>
              ) : null}
            </View>
          ))}
        </ToolResultCard>
      ) : parsed ? (
        <ToolResultCard>
          <ToolEmptyState message={connectorDiscoverEmptyMessage(isStreaming, query, true)} />
        </ToolResultCard>
      ) : output ? (
        <ToolOutputFallback output={output} isStreaming={isStreaming} toolName="discover" />
      ) : (
        <ToolResultCard>
          <ToolEmptyState message={connectorDiscoverEmptyMessage(isStreaming, query, false)} />
        </ToolResultCard>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('kortix-connectors_discover', ConnectorDiscoverTool);

// ─── describe ────────────────────────────────────────────────────────────────

export function ConnectorDescribeTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const palette = useTurnPalette();
  const input = partInput(part);
  const output = partOutput(part);
  const outputIsError = useMemo(() => isErrorOutput(output), [output]);
  const status = partStatus(part);
  const running = useContext(ToolRunningContext);
  const parsed = useMemo(() => parseConnectorOutput(output), [output]);
  const view = connectorDescribeView(input, parsed);
  const isStreaming = isToolStreaming(status, running);

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={CodeSimpleIcon}
      trigger={{ title: 'Inspected a connector action', subtitle: view.tool || undefined, args: view.triggerArgs }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {outputIsError ? (
        <ToolOutputFallback output={output} isStreaming={isStreaming} toolName="describe" />
      ) : parsed ? (
        <ToolResultCard bodyStyle={{ rowGap: webSpace(2.5), padding: webSpace(2) }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: TURN_SPACE.gap2 }}>
            <Text style={[TURN_TYPE.xs, { flexShrink: 1, fontFamily: monoFont, color: palette.foreground }]}>{view.tool}</Text>
            <ConnectorRiskBadge risk={view.risk} />
          </View>
          {view.description ? (
            <Text variant="muted" style={[TURN_TYPE.xsRelaxed, { color: palette.mutedForeground }]}>
              {view.description}
            </Text>
          ) : null}
          {/* What the action is answers the card; its argument schema is for the model. */}
          <Section section={CONNECTOR_DESCRIBE_SCHEMA_SECTION}>
            <ConnectorJson value={view.schema} />
          </Section>
        </ToolResultCard>
      ) : output ? (
        <ToolOutputFallback output={output} isStreaming={isStreaming} toolName="describe" />
      ) : (
        <ToolResultCard>
          <ToolEmptyState message={isStreaming ? 'Loading schema…' : 'No schema yet.'} />
        </ToolResultCard>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('kortix-connectors_describe', ConnectorDescribeTool);

// ─── call ────────────────────────────────────────────────────────────────────

export function ConnectorCallTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const palette = useTurnPalette();
  const input = partInput(part);
  const output = partOutput(part);
  const outputIsError = useMemo(() => isErrorOutput(output), [output]);
  const status = partStatus(part);
  const running = useContext(ToolRunningContext);
  const parsed = useMemo(() => parseConnectorOutput(output), [output]);
  const view = useMemo(() => connectorCallView(input, parsed), [input, parsed]);
  const isStreaming = isToolStreaming(status, running);

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={TerminalWindowIcon}
      trigger={{ title: 'Used a connector', subtitle: view.ref || undefined, args: view.triggerArgs }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      <>
        <ToolResultCard bodyStyle={{ rowGap: webSpace(2.5), padding: webSpace(2) }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: TURN_SPACE.gap2 }}>
            <Text style={[TURN_TYPE.xs, { flexShrink: 1, fontFamily: monoFont, color: palette.foreground }]}>{view.ref}</Text>
            <ConnectorRiskBadge risk={parsed?.risk} />
            {view.outcome ? (
              <StatusLabel color={toneColor(palette, view.outcome.tone)} style={{ marginLeft: 'auto' }}>
                {view.outcome.label}
              </StatusLabel>
            ) : null}
          </View>

          {Object.keys(view.args).length > 0 ? (
            <Section section={CONNECTOR_CALL_SECTIONS.request}>
              <ConnectorJson value={view.args} />
            </Section>
          ) : null}

          {!outputIsError && view.response ? (
            <Section section={CONNECTOR_CALL_SECTIONS.response}>
              {view.response.kind === 'reason' ? (
                <Text selectable style={[TURN_TYPE.xs, { fontFamily: monoFont, color: palette.destructive }]}>
                  {view.response.text}
                </Text>
              ) : (
                <ConnectorJson value={view.response.value} />
              )}
            </Section>
          ) : output ? null : (
            <ToolEmptyState message={isStreaming ? 'Running…' : 'No result yet.'} />
          )}
        </ToolResultCard>

        {/* The fallback draws its own card, so it stacks below rather than nesting. */}
        {outputIsError || (!parsed && output) ? (
          <ToolOutputFallback output={output} isStreaming={isStreaming} toolName="call" />
        ) : null}
      </>
    </BasicTool>
  );
}
ToolRegistry.register('kortix-connectors_call', ConnectorCallTool);
