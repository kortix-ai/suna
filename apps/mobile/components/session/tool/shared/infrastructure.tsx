/**
 * Tool-row infrastructure — the one row every tool call renders through, and
 * the barrel a renderer ported from apps/web imports.
 *
 * ── Porting a web renderer: swap the import path, keep the names ────────────
 *
 * web `@/features/session/tool/shared/infrastructure` → `../shared/infrastructure`
 *   (everything below is re-exported here, so one import line still works)
 *
 *   BasicTool                   here — adapted: `icon` is an `AppIcon` or a node;
 *                               pass `disclosureId={disclosureKey('tool', part.id)}`
 *                               so the open state survives list recycling
 *                               (without it the row keeps local state, as web does);
 *                               `onClick` === `onPress`; `badge`, `durationMs`,
 *                               `className` are accepted and, as on web's inline
 *                               surface, not drawn
 *   partInput / partOutput / partStatus / partStreamingInput / partMetadata /
 *   firstMeaningfulLine / getAgentCardLabel / isLocalSandboxFilePath /
 *   parsePartialJSON            `@/lib/session/tool-part-accessors` — ported, same semantics
 *   isErrorOutput / looksLikeError / parseJsonFailure / partOutcome /
 *   cleanErrorMessage / formatJsonFailureOutput
 *                               `@kortix/sdk` (re-exported)
 *   ToolRunningContext / ToolOutcomeContext / StalePendingContext /
 *   TurnLiveContext / ToolDurationContext / ToolOpenContext / useToolOpen
 *                               here — ported
 *   ToolActivateContext / BoundActivateContext
 *                               here — ported (no mobile provider yet)
 *   ToolSurfaceContext / TOOL_INDENT / useToolIndent / useToolCardFrame /
 *   useToolCardPad              `./surface` — adapted: indent/pad are points,
 *                               the frame is a style object (null on 'panel')
 *   ToolNavigationContext / useToolNavigation / useProxyUrl /
 *   useServicePreview / ServicePreviewActions / ServicePreviewViewport /
 *   ServicePreviewUrlFallback / InlineServicePreview
 *                               `./navigation` — adapted: `useToolNavigation()`
 *                               adds `openFile(path, line?)` and
 *                               `openSession(id)`; previews open the Browser tab
 *                               (no iframe on mobile)
 *   ToolOutputFallback / JsonFailureOutputCard / RawOutputBlock / ToolEmptyState /
 *   StatusIcon / DiffStat / DiffChanges
 *                               here — ported
 *   ToolCodeCard / ToolCode / ToolMarkdownCard / MD_FLUSH_CLASSES
 *                               `./code-card` — ported (Shiki); `MD_FLUSH_CLASSES`
 *                               is '' — use `ToolMarkdown` for markdown bodies
 *   InlineDiffView              `./inline-diff-view` — ported (frameless, wrap in
 *                               `ToolResultCard` as web does)
 *   StructuredOutput            `./structured-output` — ported
 *   DiagnosticsDisplay / getToolDiagnostics
 *                               `./diagnostics` — ported (tap opens the file)
 *
 * web `tool/shared/result-card`        → `../shared/result-card`   ToolResultCard (`className`/`bodyClassName` → `style`/`bodyStyle`)
 * web `tool/shared/output-block`       → `../shared/output-block`  OutputBlock, ToolSection, FoldedSection, ToolField
 * web `tool/shared/file-list`          → `../shared/file-list`     ToolListRow (icon: AppIcon), InlineFileList, InlineGrepResults, parseFilePaths, parseGrepOutput
 * web `tool/shared/web-source-row`     → `../shared/web-source-row` WebSourceRow, FaviconAvatar
 * web `tool/shared/error-and-connector`→ `../shared/error-and-connector`
 * web `tool/shared/patch-helpers`      → `../shared/patch-helpers`  PatchFileLite, PATCH_TYPE_STYLE, RawPatchDiffView
 * web `tool/shared/todo-helpers`       → `../shared/todo-helpers`   parseTodos, TodoItem, TodoStatusIcon (`size`/`color` props)
 * web `tool/shared/session-helpers`    → `../shared/session-helpers`
 * web `tool/shared/show-helpers`       → `../shared/show-helpers`   (icons return `AppIcon`; no ShowCarousel/ShowContentRenderer)
 * web `tool/shared/sub-agent`          → not a primitive: it renders `ToolPartRenderer`; port with the agents family
 * web `tool/shared/{file-verb,search-query,web-helpers,…}` → `@kortix/sdk`
 *
 * Styling: web classes map to `./styles` (`TURN_TYPE`, `TURN_SPACE`,
 * `useTurnPalette()` — `text-muted-foreground/60` is `palette.muted60`) and
 * `webSpace(n)` from `@/lib/session/user-message` for any other `p-*`/`gap-*`.
 *
 * ── Row anatomy (web parity) ─────────────────────────────────────────────────
 * - row: `flex items-center gap-1.5 py-0.5`, leading icon `size-4
 *   text-muted-foreground`;
 * - title `text-sm text-foreground` (never shrinks), subtitle `text-sm
 *   text-muted-foreground` truncating (shimmer while running; tappable with
 *   `onSubtitleClick`), `DiffStat` `text-xs`, args `text-muted-foreground/40`;
 * - a failed call leads with a filled `Warning` instead of the tool's glyph;
 * - a row with no body is not a disclosure; the body animates and has `py-1`;
 * - `defaultOpen` seeds, `forceOpen` seeds and latches, `locked` refuses the close.
 * Inside a chain of thought (`ToolRowVariantContext.chain`) the row uses
 * `gap-3` and `text-sm leading-[1.5]`, as web's `activity-step.tsx` does.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Pressable, View } from 'react-native';
import type { ToolOutcome } from '@kortix/sdk';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { TextShimmer } from '@/components/kortix/text-shimmer';
import { DisclosureContent, useReportOpen } from '@/components/session/chain-of-thought';
import { Text } from '@/components/ui/text';
import { CheckIcon, MagnifyingGlassIcon, WarningCircleIcon, WarningIcon } from '@/lib/icons';
import { resolveDisclosureOpen } from '@/lib/session/activity';
import { useDisclosureChoice, useDisclosureStore } from '@/lib/session/disclosure-store';
import {
  cleanErrorMessage,
  formatJsonFailureOutput,
  formatRawOutput,
  looksLikeError,
  looksLikeJsonPayload,
  looksLikeMarkdown,
  parseJsonFailure,
  type ParsedJsonFailure,
} from '@/lib/session/tool-part-accessors';
import { webSpace } from '@/lib/session/user-message';
import { ToolError } from '../tool-error';
import { ToolMarkdown, ToolOutputCard } from './code-card';
import { ToolResultCard } from './result-card';
import { TURN_SPACE, TURN_TYPE, monoFont, useTurnPalette } from './styles';
import { ToolIconSlot, useToolRowVariant, type ToolIcon } from './surface';

// ─── Re-exports (web import parity) ──────────────────────────────────────────

export {
  cleanErrorMessage,
  firstMeaningfulLine,
  formatJsonFailureOutput,
  getAgentCardLabel,
  isErrorOutput,
  isLocalSandboxFilePath,
  looksLikeError,
  parseJsonFailure,
  parsePartialJSON,
  partInput,
  partMetadata,
  partOutcome,
  partOutput,
  partStatus,
  partStreamingInput,
  type ParsedJsonFailure,
  type ToolOutcome,
} from '@/lib/session/tool-part-accessors';
export {
  TOOL_INDENT,
  ToolCaret,
  ToolCardFrame,
  ToolCopyButton,
  ToolIconSlot,
  ToolRowVariantContext,
  ToolSurfaceContext,
  useToolCardFrame,
  useToolCardPad,
  useToolIndent,
  useToolRowVariant,
  type ToolIcon,
  type ToolSurface,
} from './surface';
export {
  InlineServicePreview,
  ServicePreviewActions,
  ServicePreviewUrlFallback,
  ServicePreviewViewport,
  ToolFilePreviewHost,
  ToolNavigationContext,
  useProxyUrl,
  useServicePreview,
  useToolFilePreviewStore,
  useToolNavigation,
  type ServicePreviewState,
  type ToolNavigationTab,
} from './navigation';
export {
  HighlightedCode,
  MD_FLUSH_CLASSES,
  MarkdownFrontmatterCard,
  ToolCode,
  ToolCodeCard,
  ToolMarkdown,
  ToolMarkdownCard,
  ToolOutputCard,
} from './code-card';
export { DiffView, InlineDiffView } from './inline-diff-view';
export { StructuredOutput } from './structured-output';
export { DiagnosticsDisplay, getToolDiagnostics } from './diagnostics';
export { ToolResultCard } from './result-card';

// ─── Ambient per-part state (web contexts of the same names) ─────────────────

/** The call is in flight. Supplied by `ToolPartRenderer`. */
export const ToolRunningContext = createContext(false);
/** This call's verdict (`partOutcome`). */
export const ToolOutcomeContext = createContext<ToolOutcome>('ok');
/** An input-less pending call from a turn that is over. */
export const StalePendingContext = createContext(false);
/** The turn that owns this part is still working. */
export const TurnLiveContext = createContext(false);
export const ToolDurationContext = createContext<number | undefined>(undefined);
/** Whether the row a trigger belongs to is expanded. */
export const ToolOpenContext = createContext(false);
/** Opens a tool call (by `callID`) in a detail surface. Mobile has none yet. */
export const ToolActivateContext = createContext<((callID: string) => void) | null>(null);
/** `ToolActivateContext` bound to one call: a row press activates instead of expanding. */
export const BoundActivateContext = createContext<(() => void) | null>(null);

export function useToolOpen(): boolean {
  return useContext(ToolOpenContext);
}

// ─── Trigger ─────────────────────────────────────────────────────────────────

export interface TriggerTitle {
  title: string;
  subtitle?: string;
  args?: string[];
  stat?: { additions: number; deletions: number };
  /** Drop the subtitle while the row is open (the card spells it out). */
  hideSubtitleWhenOpen?: boolean;
}

function isTriggerTitle(value: unknown): value is TriggerTitle {
  return (
    typeof value === 'object' &&
    value !== null &&
    'title' in value &&
    typeof (value as TriggerTitle).title === 'string'
  );
}

/** `+N` success / `−N` destructive, mono, tabular. Renders nothing for 0 / 0. */
export function DiffStat({ additions, deletions }: { additions?: number; deletions?: number }) {
  const palette = useTurnPalette();
  const { chain } = useToolRowVariant();
  if (!additions && !deletions) return null;
  const type = chain ? TURN_TYPE.rowSm : TURN_TYPE.xs;
  const base = [type, { fontFamily: monoFont, fontVariant: ['tabular-nums' as const] }];
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: TURN_SPACE.gap1_5, flexShrink: 0 }}>
      {additions ? <Text style={[base, { color: palette.success }]}>+{additions}</Text> : null}
      {deletions ? <Text style={[base, { color: palette.destructive }]}>{`−${deletions}`}</Text> : null}
    </View>
  );
}

/** Web `DiffChanges`: a `DiffStat` pushed to the row's right edge. */
export function DiffChanges({ additions, deletions }: { additions: number; deletions: number }) {
  if (additions === 0 && deletions === 0) return null;
  return (
    <View style={{ marginLeft: 'auto' }}>
      <DiffStat additions={additions} deletions={deletions} />
    </View>
  );
}

function InlineTriggerTitle({
  trigger,
  running,
  onSubtitleClick,
}: {
  trigger: TriggerTitle;
  running: boolean;
  onSubtitleClick?: () => void;
}) {
  const palette = useTurnPalette();
  const { chain } = useToolRowVariant();
  const open = useToolOpen();
  const type = chain ? TURN_TYPE.rowSm : TURN_TYPE.sm;
  const args = trigger.args ?? [];
  const subtitle = open && trigger.hideSubtitleWhenOpen ? undefined : trigger.subtitle;

  return (
    <>
      <Text numberOfLines={1} style={[type, { flexShrink: 0, color: palette.foreground }]}>
        {trigger.title}
      </Text>
      {subtitle || args.length > 0 || trigger.stat ? (
        <View
          style={{
            flex: 1,
            minWidth: 0,
            flexDirection: 'row',
            alignItems: 'center',
            gap: TURN_SPACE.gap1_5,
            overflow: 'hidden',
          }}
        >
          {subtitle ? (
            running ? (
              <TextShimmer variant="muted" style={type} numberOfLines={1}>
                {subtitle}
              </TextShimmer>
            ) : (
              <Text
                variant="muted"
                numberOfLines={1}
                accessibilityRole={onSubtitleClick ? 'link' : undefined}
                onPress={onSubtitleClick}
                style={[type, { flexShrink: 1, color: palette.mutedForeground }]}
              >
                {subtitle}
              </Text>
            )
          ) : null}
          {trigger.stat ? (
            <DiffStat additions={trigger.stat.additions} deletions={trigger.stat.deletions} />
          ) : null}
          {args.length > 0 ? (
            <>
              {subtitle ? <Text variant="muted" style={[type, { flexShrink: 0, color: palette.muted40 }]}>·</Text> : null}
              <Text variant="muted" numberOfLines={1} style={[type, { flexShrink: 1, color: palette.muted40 }]}>
                {args.join(' · ')}
              </Text>
            </>
          ) : null}
        </View>
      ) : null}
    </>
  );
}

function ToolHeaderRow({
  icon,
  trigger,
  running,
  outcome,
  action,
  onSubtitleClick,
}: {
  icon?: ToolIcon;
  trigger: TriggerTitle | ReactNode;
  running: boolean;
  outcome: ToolOutcome;
  action?: ReactNode;
  onSubtitleClick?: () => void;
}) {
  const palette = useTurnPalette();
  const { hideIcon } = useToolRowVariant();

  return (
    <>
      {outcome !== 'ok' ? (
        <View
          accessible
          accessibilityLabel={outcome === 'failed' ? 'This step failed' : 'This step partly failed'}
        >
          <WarningIcon weight="fill" size={TURN_SPACE.icon} color={palette.mutedForeground} />
        </View>
      ) : !hideIcon && icon ? (
        <View style={{ width: TURN_SPACE.icon, height: TURN_SPACE.icon, flexShrink: 0, alignItems: 'center', justifyContent: 'center' }}>
          <ToolIconSlot icon={icon} size={TURN_SPACE.icon} color={palette.mutedForeground} />
        </View>
      ) : null}
      <View
        style={{
          flex: 1,
          minWidth: 0,
          flexDirection: 'row',
          alignItems: 'center',
          gap: TURN_SPACE.gap1_5,
          overflow: 'hidden',
        }}
      >
        {isTriggerTitle(trigger) ? (
          <InlineTriggerTitle trigger={trigger} running={running} onSubtitleClick={onSubtitleClick} />
        ) : (
          trigger
        )}
      </View>
      {action ? <View style={{ marginLeft: 'auto', flexShrink: 0 }}>{action}</View> : null}
    </>
  );
}

// ─── BasicTool ───────────────────────────────────────────────────────────────

export interface BasicToolProps {
  /**
   * Disclosure-store key for this row (`disclosureKey('tool', part.id)`). The
   * store keeps the user's choice across FlatList recycling; without a key the
   * row holds its open state locally, as web's `useState` does.
   */
  disclosureId?: string;
  /** An `AppIcon` (sized and tinted by the row) or a node rendered as given. */
  icon?: ToolIcon;
  trigger: TriggerTitle | ReactNode;
  children?: ReactNode;
  defaultOpen?: boolean;
  forceOpen?: boolean;
  locked?: boolean;
  /** Plain button row: fires instead of expanding. */
  onPress?: () => void;
  /** Web name for `onPress`. */
  onClick?: () => void;
  /** Makes the subtitle tappable (open the file it names). */
  onSubtitleClick?: () => void;
  /** Web draws it on the panel surface only; accepted for parity. */
  badge?: ReactNode;
  /** Accepted for parity; web does not draw it on the inline row. */
  durationMs?: number;
  /** Web panel-body class; accepted for parity. */
  className?: string;
  /** One control pinned to the row's right edge. */
  triggerAction?: ReactNode;
}

export function BasicTool({
  disclosureId,
  icon,
  trigger,
  children,
  defaultOpen = false,
  forceOpen,
  locked,
  onPress,
  onClick,
  onSubtitleClick,
  triggerAction,
}: BasicToolProps) {
  const running = useContext(ToolRunningContext);
  const outcome = useContext(ToolOutcomeContext);
  const activate = useContext(BoundActivateContext);
  const { chain } = useToolRowVariant();
  const storedChoice = useDisclosureChoice(disclosureId ?? '');
  const [localChoice, setLocalChoice] = useState<boolean | undefined>(undefined);
  const choice = disclosureId ? storedChoice : localChoice;
  const open = resolveDisclosureOpen({ userChoice: choice, auto: defaultOpen, forceOpen });
  const hasBody = Boolean(children);
  const press = onPress ?? onClick;
  const activates = Boolean(activate) && !locked && !forceOpen && !defaultOpen;

  // `forceOpen` latches: once a permission or question opened the row, it
  // stays open after the prompt resolves.
  useEffect(() => {
    if (!forceOpen) return;
    if (disclosureId) useDisclosureStore.getState().setChoice(disclosureId, true);
    else setLocalChoice(true);
  }, [forceOpen, disclosureId]);

  useReportOpen(open && hasBody && !press && !activates);

  const toggle = useCallback(() => {
    if (locked && open) return;
    if (disclosureId) useDisclosureStore.getState().setChoice(disclosureId, !open);
    else setLocalChoice(!open);
  }, [disclosureId, locked, open]);

  const rowStyle = useMemo(
    () => ({
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: chain ? TURN_SPACE.gap3 : TURN_SPACE.gap1_5,
      paddingVertical: TURN_SPACE.rowPadY,
      maxWidth: '100%' as const,
    }),
    [chain],
  );

  const header = (
    <ToolHeaderRow
      icon={icon}
      trigger={trigger}
      running={running}
      outcome={outcome}
      action={triggerAction}
      onSubtitleClick={onSubtitleClick}
    />
  );

  if (press) {
    return (
      <Pressable accessibilityRole="button" onPress={locked ? undefined : press} style={rowStyle}>
        {header}
      </Pressable>
    );
  }

  if (activates && activate) {
    return (
      <Pressable accessibilityRole="button" onPress={activate} style={rowStyle}>
        {header}
      </Pressable>
    );
  }

  return (
    <ToolOpenContext.Provider value={open}>
      {hasBody ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={toggle}
          style={rowStyle}
        >
          {header}
        </Pressable>
      ) : (
        <View style={rowStyle}>{header}</View>
      )}
      {hasBody ? (
        <DisclosureContent open={open}>
          <View style={{ paddingVertical: TURN_SPACE.bodyPadY }}>{children}</View>
        </DisclosureContent>
      ) : null}
    </ToolOpenContext.Provider>
  );
}

// ─── Status icon ─────────────────────────────────────────────────────────────

export function StatusIcon({ status }: { status: string }) {
  const palette = useTurnPalette();
  switch (status) {
    case 'completed':
      return <CheckIcon size={TURN_SPACE.statusIcon} color={palette.success} />;
    case 'error':
      return <WarningCircleIcon size={TURN_SPACE.statusIcon} color={palette.mutedForeground} />;
    case 'running':
    case 'pending':
      return <KortixLoader customSize={TURN_SPACE.statusIcon} />;
    default:
      return null;
  }
}

// ─── Empty state ─────────────────────────────────────────────────────────────

/** Web: `text-muted-foreground/40 flex items-center justify-center gap-1.5 px-3 py-3`, `size-3` search glyph, `text-xs`. */
export function ToolEmptyState({ message }: { message: string }) {
  const palette = useTurnPalette();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: TURN_SPACE.gap1_5,
        padding: TURN_SPACE.cardPad,
      }}
    >
      <MagnifyingGlassIcon size={TURN_SPACE.statusIcon} color={palette.muted40} />
      <Text variant="muted" style={[TURN_TYPE.xs, { color: palette.muted40 }]}>
        {message}
      </Text>
    </View>
  );
}

// ─── Output fallback ─────────────────────────────────────────────────────────

/**
 * The `{success:false,error,hint?}` contract as a card body: web
 * `flex items-start gap-2.5 px-3 py-2.5 text-xs`, a `size-5 rounded-sm
 * bg-destructive/10` well with a `size-3.5` destructive `WarningCircle`,
 * summary `text-foreground/90`, detail `text-muted-foreground`, hint
 * `text-muted-foreground/80` (all `leading-relaxed`), and the HTTP status in
 * mono `text-muted-foreground/60`.
 */
export function JsonFailureOutputCard({ failure }: { failure: ParsedJsonFailure; toolName?: string }) {
  const palette = useTurnPalette();
  const summary = cleanErrorMessage(failure.errorSummary);
  const detail = failure.nestedMessage ? cleanErrorMessage(failure.nestedMessage) : undefined;
  const body = TURN_TYPE.xsRelaxed;

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: webSpace(2.5),
        paddingHorizontal: TURN_SPACE.cardPad,
        paddingVertical: webSpace(2.5),
      }}
    >
      <View
        style={{
          marginTop: 1,
          width: webSpace(5),
          height: webSpace(5),
          flexShrink: 0,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: TURN_SPACE.radiusSm,
          backgroundColor: palette.destructive10,
        }}
      >
        <WarningCircleIcon size={TURN_SPACE.caret} color={palette.destructive} />
      </View>
      <View style={{ flex: 1, minWidth: 0, rowGap: webSpace(1) }}>
        <Text variant="muted" selectable style={[body, { color: palette.foreground90 }]}>
          {summary}
        </Text>
        {detail && detail !== summary ? (
          <Text variant="muted" selectable style={[body, { color: palette.mutedForeground }]}>
            {detail}
          </Text>
        ) : null}
        {failure.hint ? (
          <Text variant="muted" selectable style={[body, { color: palette.muted80 }]}>
            {failure.hint.trim()}
          </Text>
        ) : null}
      </View>
      {typeof failure.status === 'number' ? (
        <Text
          variant="muted"
          style={[TURN_TYPE.xs, { flexShrink: 0, fontFamily: monoFont, fontVariant: ['tabular-nums'], color: palette.muted60 }]}
        >
          {failure.status}
        </Text>
      ) : null}
    </View>
  );
}

const RAW_OUTPUT_MAX_CHARS = 2000;

/**
 * Raw tool output: web `RawOutputBlock` — the output card with a copy button
 * that copies the FULL output; JSON pretty-printed and capped at `maxChars`
 * (`formatRawOutput`) with a "+N more characters" note
 * (`text-muted-foreground/40 mt-2 text-xs`); markdown renders as markdown,
 * everything else mono `text-xs leading-relaxed text-muted-foreground`.
 */
export function RawOutputBlock({ output, maxChars = RAW_OUTPUT_MAX_CHARS }: { output: string; maxChars?: number }) {
  const palette = useTurnPalette();
  const { text, truncatedChars } = useMemo(() => formatRawOutput(output, maxChars), [output, maxChars]);
  const isMarkdown = useMemo(() => looksLikeMarkdown(text), [text]);

  return (
    <ToolOutputCard copyText={output}>
      {isMarkdown ? (
        <ToolMarkdown content={text} />
      ) : (
        <Text
          variant="muted"
          selectable
          style={[TURN_TYPE.xsRelaxed, { fontFamily: monoFont, color: palette.mutedForeground }]}
        >
          {text}
        </Text>
      )}
      {truncatedChars > 0 ? (
        <Text variant="muted" style={[TURN_TYPE.xs, { marginTop: TURN_SPACE.gap2, color: palette.muted40 }]}>
          +{truncatedChars.toLocaleString()} more characters — copy for the full output
        </Text>
      ) : null}
    </ToolOutputCard>
  );
}

/**
 * The body of a tool with nothing better to show. Same branch order as web:
 * the `{success:false}` contract → `JsonFailureOutputCard` in a
 * `ToolResultCard`; a JSON failure or an error-looking string → `ToolError`;
 * JSON or anything over 4000 characters → `RawOutputBlock`; short prose →
 * markdown in the output card.
 */
export function ToolOutputFallback({
  output,
  isStreaming = false,
  toolName,
}: {
  output: string;
  isStreaming?: boolean;
  toolName?: string;
}) {
  const parsedJsonFailure = !isStreaming ? parseJsonFailure(output) : null;
  if (parsedJsonFailure) {
    return (
      <ToolResultCard>
        <JsonFailureOutputCard failure={parsedJsonFailure} toolName={toolName} />
      </ToolResultCard>
    );
  }

  const jsonFailure = !isStreaming ? formatJsonFailureOutput(output) : null;
  if (jsonFailure) return <ToolError error={jsonFailure} toolName={toolName} />;

  if (!isStreaming && looksLikeError(output)) return <ToolError error={output} toolName={toolName} />;

  if (looksLikeJsonPayload(output) || output.length > 4000) return <RawOutputBlock output={output} />;

  return (
    <ToolOutputCard copyText={output}>
      <ToolMarkdown content={output} isStreaming={isStreaming} />
    </ToolOutputCard>
  );
}
