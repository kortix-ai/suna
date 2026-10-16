/**
 * `codemode` (pi): one JavaScript script that calls other tools. Port of apps/web
 * `tool/tools/codemode-tool.tsx`:
 * - trigger: "Running script" (shimmer) / "Script failed" / "Ran script", and,
 *   closed, "N tool calls · name · name";
 * - card: the script's tool calls first (status mark, name, main argument,
 *   duration, a failed call's error), then the script (Shiki javascript), then
 *   its result without pi's `Script completed` / `Wall time` / `Output:` header.
 */

import { getToolPrimaryArg } from '@kortix/sdk';
import { useContext } from 'react';
import { View } from 'react-native';
import { TextShimmer } from '@/components/kortix/text-shimmer';
import { Text } from '@/components/ui/text';
import { CheckIcon, FileCodeIcon, MinusIcon, ProhibitIcon, WarningIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { BASH_PANE, bashPaneInset } from '@/lib/session/tools/files-bash';
import { webSpace } from '@/lib/session/user-message';
import { THEME } from '@/lib/utils/theme';
import {
  BasicTool,
  HighlightedCode,
  partError,
  partInput,
  partMetadata,
  partOutput,
  partStatus,
  RunningLoader,
  ToolCopyButton,
  ToolRunningContext,
  ToolScroll,
  useToolCardFrame,
  useToolCardPad,
  useToolIndent,
  useToolOpen,
} from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { TURN_SPACE, TURN_TYPE, monoFont, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';

const TEXT = {
  ran: 'Ran script',
  running: 'Running script',
  failed: 'Script failed',
  noOutput: 'No output',
  calls: (count: number) => (count === 1 ? '1 tool call' : `${count} tool calls`),
} as const;

/** One tool call a codemode script made. */
export interface ScriptCall {
  id: string;
  name: string;
  arg: string;
  status: 'running' | 'ok' | 'error' | 'refused' | 'cancelled';
  durationMs?: number;
  error?: string;
}

const STATUS: Record<string, ScriptCall['status']> = {
  running: 'running',
  ok: 'ok',
  complete: 'ok',
  error: 'error',
  cancelled: 'cancelled',
  interrupted: 'cancelled',
};

/** The reasons the pi runtime blocks a call with (kortixd `pi/runtime.ts`). */
const REFUSED = /^(The project policy denies|The user rejected|Call \S+ directly, not from a script)/;

function callArg(name: string, input: unknown): string {
  if (input === undefined || input === '') return '';
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      return input;
    }
  }
  const primary =
    value && typeof value === 'object'
      ? getToolPrimaryArg({ type: 'tool', tool: name, state: { status: 'completed', input: value } } as never)
      : '';
  return primary || (typeof value === 'string' ? value : JSON.stringify(value));
}

/** The calls a script made: pi's live record (`id`, `args`) or the session log's (`call_id`, `input`). */
export function scriptCalls(metadata: Record<string, unknown>): ScriptCall[] {
  const calls = Array.isArray(metadata.calls) ? (metadata.calls as Array<Record<string, unknown>>) : [];
  return calls.map((c) => {
    const status = STATUS[String(c.status)] ?? 'cancelled';
    const duration = c.durationMs ?? c.duration_ms;
    return {
      id: String(c.id ?? c.call_id ?? ''),
      name: String(c.name ?? ''),
      arg: callArg(String(c.name ?? ''), c.args ?? c.input),
      status: status === 'error' && typeof c.error === 'string' && REFUSED.test(c.error) ? 'refused' : status,
      ...(typeof duration === 'number' ? { durationMs: duration } : {}),
      ...(typeof c.error === 'string' && c.error ? { error: c.error } : {}),
    };
  });
}

/** The script's result without pi's `Script completed|failed`, `Wall time` and `Output:` header lines. */
export function scriptResult(text: string): string {
  return text.replace(/^Script (?:completed|failed)\n(?:Wall time [^\n]*\n)?(?:Output:\n)?/, '').trim();
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function CallMark({ status }: { status: ScriptCall['status'] }) {
  const palette = useTurnPalette();
  const size = TURN_SPACE.statusIcon;
  if (status === 'running') return <RunningLoader size={size} />;
  if (status === 'ok') return <CheckIcon size={size} color={THEME.accent.green} />;
  if (status === 'error') return <WarningIcon weight="fill" size={size} color={THEME.accent.red} />;
  if (status === 'refused') return <ProhibitIcon weight="fill" size={size} color={THEME.accent.orange} />;
  return <MinusIcon size={size} color={palette.mutedForeground} />;
}

function CallList({ calls }: { calls: ScriptCall[] }) {
  const palette = useTurnPalette();
  return (
    <View style={{ gap: webSpace(1) }}>
      {calls.map((call, index) => (
        <View key={call.id || index}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: TURN_SPACE.gap2, minWidth: 0 }}>
            <CallMark status={call.status} />
            <Text style={[TURN_TYPE.xsRelaxed, { flexShrink: 0, fontFamily: monoFont, color: palette.foreground }]}>
              {call.name}
            </Text>
            <Text
              numberOfLines={1}
              style={[TURN_TYPE.xsRelaxed, { flex: 1, minWidth: 0, fontFamily: monoFont, color: palette.mutedForeground }]}
            >
              {call.arg}
            </Text>
            {call.durationMs !== undefined ? (
              <Text style={[TURN_TYPE.xsRelaxed, { flexShrink: 0, fontVariant: ['tabular-nums'], color: palette.mutedForeground }]}>
                {formatDuration(call.durationMs)}
              </Text>
            ) : null}
          </View>
          {call.error ? (
            <Text
              selectable
              style={[TURN_TYPE.xsRelaxed, { paddingLeft: webSpace(5), fontFamily: monoFont, color: palette.mutedForeground }]}
            >
              {call.error}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

/** The row's words stay ink: the outcome mark `BasicTool` draws carries a failure's hue. */
function ScriptTrigger({ title, live, summary }: { title: string; live: boolean; summary: string }) {
  const palette = useTurnPalette();
  const open = useToolOpen();
  return (
    <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: TURN_SPACE.gap1_5, overflow: 'hidden' }}>
      {live ? (
        <TextShimmer duration={1} spread={2} style={TURN_TYPE.xs} numberOfLines={1}>
          {title}
        </TextShimmer>
      ) : (
        <Text numberOfLines={1} style={[TURN_TYPE.xs, { flexShrink: 0, color: palette.foreground }]}>
          {title}
        </Text>
      )}
      {!open && summary ? (
        <Text numberOfLines={1} style={[TURN_TYPE.xs, { flexShrink: 1, color: palette.mutedForeground }]}>
          {summary}
        </Text>
      ) : null}
    </View>
  );
}

export function CodemodeTool({ call, defaultOpen, forceOpen, locked }: ToolProps) {
  const palette = useTurnPalette();
  const running = useContext(ToolRunningContext);
  const frame = useToolCardFrame();
  const pad = useToolCardPad();
  const indent = useToolIndent();
  const inset = bashPaneInset(pad);

  const input = partInput(call);
  const code = typeof input.code === 'string' ? input.code.trim() : '';
  const calls = scriptCalls(partMetadata(call));
  const status = partStatus(call);
  const failed = status === 'error';
  const live = running && !failed && status !== 'completed';
  const result = scriptResult(failed ? (partError(call) ?? '') : partOutput(call));
  const names = [...new Set(calls.map((c) => c.name))].join(' · ');
  const summary = calls.length ? `${TEXT.calls(calls.length)}${names ? ` · ${names}` : ''}` : '';

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', call.id)}
      icon={FileCodeIcon}
      trigger={<ScriptTrigger title={live ? TEXT.running : failed ? TEXT.failed : TEXT.ran} live={live} summary={summary} />}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      <View style={indent ? { marginTop: TURN_SPACE.gap1_5, marginLeft: indent } : undefined}>
        <View style={[{ position: 'relative', overflow: 'hidden' }, frame]}>
          {calls.length > 0 ? (
            <View style={[inset, { borderBottomWidth: 1, borderBottomColor: palette.border60 }]}>
              <CallList calls={calls} />
            </View>
          ) : null}
          {code ? (
            <View style={{ position: 'relative' }}>
              <ToolScroll
                maxHeight={BASH_PANE.commandMaxHeight}
                style={{ backgroundColor: frame ? palette.muted40Bg : undefined }}
                showsVerticalScrollIndicator
              >
                <View style={inset}>
                  <HighlightedCode code={code} language="javascript" typeStyle={TURN_TYPE.xsRelaxed} color={palette.foreground90} />
                </View>
              </ToolScroll>
              <ToolCopyButton text={code} />
            </View>
          ) : null}
          {result || status === 'completed' ? (
            <View style={{ position: 'relative', borderTopWidth: 1, borderTopColor: palette.border60 }}>
              <ToolScroll maxHeight={BASH_PANE.outputMaxHeight} showsVerticalScrollIndicator>
                <View style={inset}>
                  <Text
                    selectable
                    style={[
                      TURN_TYPE.xsRelaxed,
                      { fontFamily: monoFont, color: failed ? palette.foreground : palette.mutedForeground },
                    ]}
                  >
                    {result || TEXT.noOutput}
                  </Text>
                </View>
              </ToolScroll>
              {result ? <ToolCopyButton text={result} /> : null}
            </View>
          ) : null}
        </View>
      </View>
    </BasicTool>
  );
}

ToolRegistry.register('codemode', CodemodeTool);
