/**
 * `bash`. Port of apps/web `tool/tools/bash-tool.tsx`:
 * - trigger: settled → the title (`bashRowTitle`: "Command failed" in
 *   kortix-red / the model's description / "Ran command") + the first command
 *   line in mono `text-muted-foreground/60` + `+N` extra lines
 *   (`text-muted-foreground/40`); open, the row drops the command (the card
 *   shows it). Live → "Running command" + the command shimmering (duration 1s,
 *   spread 2); open, the shimmer moves to the label. An input-less call from a
 *   finished turn shimmers "Working...". `text-xs` spans; `text-sm
 *   leading-[1.5]` inside a chain, as web's `activity-step` forces;
 * - card (`CommandBlock`): the frame (`border bg-popover rounded-md`, inline
 *   only); command pane `bg-muted/40` `max-h-64`, Shiki bash, mono `text-xs
 *   leading-relaxed`, `p-3 pr-11` (panel: `py-2 pr-11`), copy button; output
 *   pane under a `border-border/60` hairline, `max-h-80`, muted mono, its own
 *   copy button — or the session list / message list / structured sections
 *   when the output parses as one; "No output" (`/50`) once settled; a failed
 *   exit code strip in kortix-red, mono `tabular-nums`, `py-2`.
 *
 * Every decision lives in `@/lib/session/tools/files-bash` (tested).
 *
 * `ShellExpandedContent` / `HighlightedBashCommand` below are the previous
 * mobile renderer, still imported by `tool-part-renderer.tsx`'s legacy switch.
 */

import { useContext, useMemo } from 'react';
import { View } from 'react-native';
import { stripAnsi } from '@kortix/sdk';
import { TextShimmer } from '@/components/kortix/text-shimmer';
import { Text } from '@/components/ui/text';
import { TerminalIcon } from '@/lib/icons';
import type { ToolPart } from '@/lib/opencode/types';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { tokenizeBash, type BashToken } from '@/lib/session/highlight-tokens';
import {
  BASH_PANE,
  BASH_TEXT,
  bashCommand,
  bashExitCode,
  bashExitLine,
  bashOutputRegion,
  bashOutputView,
  bashPaneInset,
  bashRowTitle,
  bashTriggerContent,
  commandPreview,
  type BashOutputView,
} from '@/lib/session/tools/files-bash';
import { webSpace } from '@/lib/session/user-message';
import { THEME } from '@/lib/utils/theme';
import {
  BasicTool,
  HighlightedCode,
  partInput,
  partMetadata,
  partOutput,
  partStatus,
  partStreamingInput,
  StructuredOutput,
  ToolCopyButton,
  ToolRunningContext,
  useToolCardFrame,
  useToolCardPad,
  useToolIndent,
  useToolOpen,
  useToolRowVariant,
} from '../shared/infrastructure';
import { OutputSection } from '../shared/output-block';
import { ToolRegistry } from '../shared/registry';
import { InlineSessionMessagesList, SessionMetadataList } from '../shared/session-helpers';
import { TURN_SPACE, TURN_TYPE, fg, monoFont, muted, useTurnPalette } from '../shared/styles';
import { getToolInput } from '../shared/tool-part';
import type { ToolProps } from '../shared/types';
import { ToolScroll } from '../shared/surface';

function RichOutput({ view }: { view: BashOutputView }) {
  if (view.kind === 'sessionMeta') return <SessionMetadataList sessions={view.sessions} />;
  if (view.kind === 'sessionMessages') return <InlineSessionMessagesList messages={view.messages} />;
  if (view.kind === 'structured') return <StructuredOutput sections={view.sections} />;
  return null;
}

function CommandBlock({
  command,
  view,
  exitCode,
  settled,
}: {
  command: string;
  view: BashOutputView;
  exitCode: number | undefined;
  /** The call has finished. Until it has, silence means "not yet", not "none". */
  settled: boolean;
}) {
  const palette = useTurnPalette();
  const frame = useToolCardFrame();
  const pad = useToolCardPad();
  const paneInset = bashPaneInset(pad);
  const region = bashOutputRegion(view, settled);
  const exitLine = bashExitLine(exitCode);

  return (
    // `overflow: hidden` clips the command pane's tint to the rounded frame.
    <View style={[{ position: 'relative', overflow: 'hidden' }, frame]}>
      <ToolScroll
        maxHeight={BASH_PANE.commandMaxHeight}
        style={{ backgroundColor: frame ? palette.muted40Bg : undefined }}
        showsVerticalScrollIndicator
      >
        <View style={paneInset}>
          <HighlightedCode code={command} language="bash" typeStyle={TURN_TYPE.xsRelaxed} color={palette.foreground90} />
        </View>
      </ToolScroll>
      {/* Anchored to the card, not the scroller, so it never scrolls away. */}
      <ToolCopyButton text={command} />

      {region ? (
        <View style={{ borderTopWidth: 1, borderTopColor: palette.border60 }}>
          {region === 'rich' ? (
            <RichOutput view={view} />
          ) : region === 'plain' && view.kind === 'plain' ? (
            <View style={{ position: 'relative' }}>
              <ToolScroll maxHeight={BASH_PANE.outputMaxHeight} showsVerticalScrollIndicator>
                <View style={paneInset}>
                  <Text
                    variant="muted"
                    selectable
                    style={[TURN_TYPE.xsRelaxed, { fontFamily: monoFont, color: palette.mutedForeground }]}
                  >
                    {view.text}
                  </Text>
                </View>
              </ToolScroll>
              <ToolCopyButton text={view.text} />
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
              {BASH_TEXT.noOutput}
            </Text>
          )}
        </View>
      ) : null}

      {exitLine ? (
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: palette.border60,
            paddingVertical: webSpace(2),
            paddingHorizontal: pad ? webSpace(3) : 0,
          }}
        >
          <Text
            variant="muted"
            style={[
              TURN_TYPE.xs,
              // `kortix-red`, matching the trigger's "Command failed".
              { fontFamily: monoFont, fontVariant: ['tabular-nums'], color: THEME.accent.red },
            ]}
          >
            {exitLine}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * The words on the trigger row. Its own component because `useToolOpen()`
 * only answers truthfully inside `BasicTool`'s provider.
 */
function BashTrigger(props: {
  command: string;
  running: boolean;
  status: string;
  title: string;
  failed: boolean;
  commandPreview: string;
  extraLines: number;
}) {
  const palette = useTurnPalette();
  const open = useToolOpen();
  const { chain } = useToolRowVariant();
  const type = chain ? TURN_TYPE.rowSm : TURN_TYPE.xs;
  const content = bashTriggerContent({ ...props, open });
  const rowStyle = {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: TURN_SPACE.gap1_5,
    overflow: 'hidden' as const,
  };

  if (content.kind === 'none') return null;

  if (content.kind === 'stale') {
    return (
      <View style={rowStyle}>
        <TextShimmer duration={1} spread={2} style={chain ? TURN_TYPE.rowSm : TURN_TYPE.sm} numberOfLines={1}>
          {content.label}
        </TextShimmer>
      </View>
    );
  }

  if (content.kind === 'live') {
    return (
      <View style={rowStyle}>
        {content.labelShimmers ? (
          <TextShimmer duration={1} spread={2} style={type} numberOfLines={1}>
            {content.label}
          </TextShimmer>
        ) : (
          <>
            <Text variant="muted" numberOfLines={1} style={[type, { flexShrink: 0, color: palette.foreground }]}>
              {content.label}
            </Text>
            {content.preview ? (
              <TextShimmer
                duration={1}
                spread={2}
                style={[type, { fontFamily: monoFont }]}
                numberOfLines={1}
                containerStyle={{ flexShrink: 1, minWidth: 0 }}
              >
                {content.preview}
              </TextShimmer>
            ) : null}
          </>
        )}
      </View>
    );
  }

  return (
    <View style={rowStyle}>
      <View style={{ flexShrink: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: webSpace(2) }}>
        <Text
          variant="muted"
          numberOfLines={1}
          style={[type, { flexShrink: 1, color: content.failed ? THEME.accent.red : palette.foreground }]}
        >
          {content.title}
        </Text>
        {content.preview ? (
          <Text
            variant="muted"
            numberOfLines={1}
            style={[type, { flexShrink: 1, fontFamily: monoFont, color: palette.muted60 }]}
          >
            {content.preview}
          </Text>
        ) : null}
        {content.extraLines > 0 ? (
          <Text
            variant="muted"
            style={[type, { flexShrink: 0, fontVariant: ['tabular-nums'], color: palette.muted40 }]}
          >
            +{content.extraLines}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

export function BashTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const streamingInput = partStreamingInput(part);
  const metadata = partMetadata(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const running = useContext(ToolRunningContext);
  const indent = useToolIndent();
  const command = bashCommand(input, metadata, streamingInput);
  const view = useMemo(() => bashOutputView(output), [output]);
  const exitCode = useMemo(
    () => bashExitCode(part.state as { status: string; output?: string }),
    [part.state],
  );
  const failed = typeof exitCode === 'number' && exitCode !== 0;
  const title = bashRowTitle(input.description, failed);
  const preview = useMemo(() => commandPreview(command), [command]);

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={TerminalIcon}
      trigger={
        <BashTrigger
          command={command}
          running={running}
          status={status}
          title={title}
          failed={failed}
          commandPreview={preview.commandPreview}
          extraLines={preview.extraLines}
        />
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {command ? (
        <View style={indent ? { marginTop: TURN_SPACE.gap1_5, marginLeft: indent } : undefined}>
          <CommandBlock
            command={command}
            view={view}
            exitCode={exitCode}
            settled={status === 'completed' || status === 'error'}
          />
        </View>
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('bash', BashTool);

// ─── Legacy (tool-part-renderer.tsx switch) ──────────────────────────────────

export function HighlightedBashCommand({ command, isDark }: { command: string; isDark: boolean }) {
  const tokens = useMemo(() => tokenizeBash(command), [command]);

  const colors: Record<BashToken['type'], string> = {
    prompt: muted(isDark),
    command: THEME.accent.purple, // purple
    flag: THEME.accent.blue,     // blue
    string: THEME.accent.green,   // green
    operator: THEME.accent.red, // red
    redirect: THEME.accent.red, // red
    path: fg(isDark),     // slate (near-white/dark)
    plain: fg(isDark),
  };

  const fs = 11;
  const lh = 17;

  return (
    <Text style={{ fontSize: fs, fontFamily: monoFont, lineHeight: lh }}>
      {tokens.map((token, i) => (
        <Text key={i} style={{ color: colors[token.type], fontSize: fs, fontFamily: monoFont, lineHeight: lh }}>
          {token.text}
        </Text>
      ))}
    </Text>
  );
}

export function ShellExpandedContent({ tool, isDark }: { tool: ToolPart; isDark: boolean }) {
  const input = getToolInput(tool);
  const metadata = (tool.state as any)?.metadata || {};
  const command = input.command || metadata.command || '';
  const output = useMemo(() => {
    if (tool.state.status === 'completed' && 'output' in tool.state && tool.state.output) {
      // Strip bash_metadata XML tags if present
      let raw = tool.state.output;
      raw = raw.replace(/<bash_metadata>[\s\S]*?<\/bash_metadata>/g, '');
      return stripAnsi(raw).trim();
    }
    if (tool.state.status === 'error' && 'error' in tool.state) {
      return tool.state.error;
    }
    return undefined;
  }, [tool.state]);

  return (
    <View>
      {/* Command */}
      {!!command && (
        <View style={{ paddingHorizontal: 12, paddingVertical: 10 }}>
          <HighlightedBashCommand command={command} isDark={isDark} />
        </View>
      )}
      {/* Output */}
      {!!output && (
        <OutputSection output={output} isDark={isDark} isError={tool.state.status === 'error'} />
      )}
    </View>
  );
}
