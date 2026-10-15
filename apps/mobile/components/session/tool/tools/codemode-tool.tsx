/**
 * `codemode`. Port of apps/web `tool/tools/codemode-tool.tsx`:
 * - trigger: the status title (`codemodeTitle`: "Running script" live /
 *   "Script failed" / "Ran script") + the summary ("N tool calls · names",
 *   `codemodeSummary`); the row shimmers its subtitle while the call runs;
 * - card: the script's calls first — one row per call (mark, name, argument,
 *   duration, error), the list that sets a script apart from every other row —
 *   then the script source (`HighlightedCode`, javascript, `max-h` capped,
 *   copy), then the output under a hairline (`codemodeResult` strips pi's
 *   `Script completed|failed` header lines) or "No output" once settled.
 *
 * Every decision lives in `@/lib/session/tools/codemode` (tested).
 */

import { Text } from '@/components/ui/text';
import { CheckIcon, CodeSimpleIcon, MinusIcon, ProhibitIcon, WarningIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import {
  type CodemodeCall,
  codemodeCalls,
  codemodeResult,
  codemodeSummary,
  codemodeTitle,
} from '@/lib/session/tools/codemode';
import { webSpace } from '@/lib/session/user-message';
import { THEME } from '@/lib/utils/theme';
import { useContext, useMemo } from 'react';
import { View } from 'react-native';
import {
  BasicTool,
  HighlightedCode,
  ToolCopyButton,
  ToolRunningContext,
  partError,
  partInput,
  partMetadata,
  partOutput,
  partStatus,
  useToolCardFrame,
  useToolCardPad,
} from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { TURN_SPACE, TURN_TYPE, monoFont, useTurnPalette } from '../shared/styles';
import { ToolScroll } from '../shared/surface';
import type { ToolProps } from '../shared/types';

/** Web `max-h-64` (code) and `max-h-80` (output) — two scrollers, never one. */
const CODEMODE_PANE = {
  codeMaxHeight: webSpace(64),
  outputMaxHeight: webSpace(80),
} as const;

/** Web `paneInset = pad || 'py-2'` plus the `pr-11` copy reserve. */
function paneInset(pad: number): {
  padding?: number;
  paddingVertical?: number;
  paddingRight: number;
} {
  return pad
    ? { padding: pad, paddingRight: webSpace(11) }
    : { paddingVertical: webSpace(2), paddingRight: webSpace(11) };
}

/** The mark for one call's outcome: running waits quietly, ok/error/refused carry their hue. */
function CallMark({ status }: { status: CodemodeCall['status'] }) {
  const palette = useTurnPalette();
  if (status === 'ok') return <CheckIcon size={TURN_SPACE.statusIcon} color={palette.success} />;
  if (status === 'error')
    return <WarningIcon weight="fill" size={TURN_SPACE.statusIcon} color={THEME.accent.red} />;
  if (status === 'refused')
    return <ProhibitIcon weight="fill" size={TURN_SPACE.statusIcon} color={THEME.accent.orange} />;
  return <MinusIcon size={TURN_SPACE.statusIcon} color={palette.mutedForeground} />;
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * The script's tool calls, one row each: what ran, its main argument, how long
 * it took. pi keeps no output per call; a failed call shows its error.
 */
function CallRows({ calls }: { calls: CodemodeCall[] }) {
  const palette = useTurnPalette();
  return (
    <View style={{ rowGap: webSpace(1) }}>
      {calls.map((call, index) => (
        <View key={call.id || index} style={{ rowGap: 2 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: webSpace(2) }}>
            <CallMark status={call.status} />
            <Text
              numberOfLines={1}
              style={[
                TURN_TYPE.xs,
                { fontFamily: monoFont, color: palette.foreground, flexShrink: 0 },
              ]}
            >
              {call.name}
            </Text>
            <Text
              numberOfLines={1}
              style={[
                TURN_TYPE.xs,
                { fontFamily: monoFont, color: palette.mutedForeground, flex: 1 },
              ]}
            >
              {call.arg}
            </Text>
            {call.durationMs !== undefined && (
              <Text
                style={[
                  TURN_TYPE.xs,
                  {
                    fontFamily: monoFont,
                    fontVariant: ['tabular-nums'],
                    color: palette.mutedForeground,
                    flexShrink: 0,
                  },
                ]}
              >
                {formatDuration(call.durationMs)}
              </Text>
            )}
          </View>
          {call.error && (
            <Text
              selectable
              style={[
                TURN_TYPE.xs,
                { fontFamily: monoFont, color: palette.mutedForeground, marginLeft: webSpace(5) },
              ]}
            >
              {call.error}
            </Text>
          )}
        </View>
      ))}
    </View>
  );
}

export function CodemodeTool({ call, defaultOpen, forceOpen, locked }: ToolProps) {
  const running = useContext(ToolRunningContext);
  const frame = useToolCardFrame();
  const pad = useToolCardPad();
  const palette = useTurnPalette();

  const input = partInput(call);
  const code = typeof input.code === 'string' ? (input.code as string).trim() : '';
  const calls = useMemo(() => codemodeCalls(partMetadata(call)), [call]);
  const status = partStatus(call);
  const failed = status === 'error';
  const result = codemodeResult(failed ? (partError(call) ?? '') : (partOutput(call) ?? ''));
  const summary = codemodeSummary(calls);

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', call.id)}
      icon={CodeSimpleIcon}
      trigger={{ title: codemodeTitle(status, running), subtitle: summary || undefined }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      <View style={[{ overflow: 'hidden' }, frame]}>
        {calls.length > 0 && (
          <View
            style={{
              borderBottomWidth: 1,
              borderBottomColor: palette.border60,
              ...(pad ? { padding: pad } : { paddingVertical: webSpace(2) }),
            }}
          >
            <CallRows calls={calls} />
          </View>
        )}
        {code && (
          <View style={{ position: 'relative' }}>
            <ToolScroll
              maxHeight={CODEMODE_PANE.codeMaxHeight}
              style={{ backgroundColor: frame ? palette.muted40Bg : undefined }}
            >
              <View style={paneInset(pad ?? 0)}>
                <HighlightedCode
                  code={code}
                  language="javascript"
                  typeStyle={TURN_TYPE.xsRelaxed}
                  color={palette.foreground90}
                />
              </View>
            </ToolScroll>
            <ToolCopyButton text={code} />
          </View>
        )}
        {(result || status === 'completed') && (
          <View style={{ borderTopWidth: 1, borderTopColor: palette.border60 }}>
            {result ? (
              <View style={{ position: 'relative' }}>
                <ToolScroll maxHeight={CODEMODE_PANE.outputMaxHeight}>
                  <View style={paneInset(pad ?? 0)}>
                    <Text
                      variant="muted"
                      selectable
                      style={[
                        TURN_TYPE.xsRelaxed,
                        { fontFamily: monoFont, color: palette.mutedForeground },
                      ]}
                    >
                      {result}
                    </Text>
                  </View>
                </ToolScroll>
                <ToolCopyButton text={result} />
              </View>
            ) : (
              <Text
                variant="muted"
                style={[
                  TURN_TYPE.xsRelaxed,
                  pad ? { padding: pad } : { paddingVertical: webSpace(2) },
                  { color: palette.muted50 },
                ]}
              >
                No output
              </Text>
            )}
          </View>
        )}
      </View>
    </BasicTool>
  );
}

ToolRegistry.register('codemode', CodemodeTool);
