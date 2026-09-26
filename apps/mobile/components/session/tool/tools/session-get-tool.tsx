/**
 * `session_get`. Port of apps/web `tool/tools/session-get-tool.tsx`.
 *
 * - trigger: `BookOpen` · the session title ("Session Get" before output) ·
 *   the session id · `N msgs` · `N tools` · `compressed`;
 * - body (hairline `border-border/20` between sections): a meta line (mono id,
 *   `Clock` created, `ArrowClockwise` updated, `FileText` changes, parent) in
 *   `text-xs text-muted-foreground/60`; a Todos fold (OPEN by default) with
 *   bordered check boxes; a Conversation fold (CLOSED — the transcript is the
 *   heaviest thing this row can render) holding the transcript as markdown;
 *   the compression note; "No messages in this session" when there is neither
 *   a conversation nor todos. Error payloads → `ToolOutputFallback`.
 *
 * `SessionGetExpandedContent` / `parseSessionGet` / `SessionGetData` below are
 * the previous mobile body, kept because `tool-part-renderer.tsx` imports them.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { PressableSurface } from '@/components/kortix/pressable-surface';
import { Text } from '@/components/ui/text';
import { THEME, withAlpha } from '@/lib/utils/theme';
import type { ToolPart } from '@/lib/opencode/types';
import { stripAnsi } from '@kortix/sdk';
import { DisclosureContent } from '@/components/session/chain-of-thought';
import {
  ArrowClockwiseIcon,
  ArrowsInSimpleIcon,
  BookOpenIcon,
  ChatCircleIcon,
  CheckIcon,
  ClockIcon,
  FileTextIcon,
  ListChecksIcon,
  type AppIcon,
} from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { parseSessionGetOutput, sessionGetHeaderArgs } from '@/lib/session/tools/agents-session';
import { webSpace } from '@/lib/session/user-message';
import {
  BasicTool,
  ToolOutputFallback,
  isErrorOutput,
  partInput,
  partOutput,
} from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { ToolCaret, ToolScroll } from '../shared/surface';
import type { ToolProps } from '../shared/types';
import { FONT_MEDIUM, TURN_SPACE, TURN_TYPE, fg, monoFont, muted, mutedStrong, useTurnPalette } from '../shared/styles';
import { MonoBlock, OutputBlock } from '../shared/output-block';

/** `text-xs leading-snug`. */
const SNUG = { fontSize: TURN_TYPE.xs.fontSize, lineHeight: TURN_TYPE.xs.fontSize * 1.375 };
const META_ICON = webSpace(2.5);

function MetaItem({ icon: Glyph, children, mono }: { icon?: AppIcon; children: ReactNode; mono?: boolean }) {
  const palette = useTurnPalette();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: webSpace(1) }}>
      {Glyph ? <Glyph size={META_ICON} color={palette.muted60} /> : null}
      <Text variant="muted" style={[TURN_TYPE.xs, { color: palette.muted60 }, mono && { fontFamily: monoFont }]}>
        {children}
      </Text>
    </View>
  );
}

/** Web `Disclosure` + a `px-3 py-1.5` trigger: caret, glyph, `text-xs font-medium` label, count at the right. */
function SectionFold({
  open,
  onToggle,
  icon: Glyph,
  label,
  count,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  icon: AppIcon;
  label: string;
  count: string;
  children: ReactNode;
}) {
  const palette = useTurnPalette();
  return (
    <View>
      <PressableSurface
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={label}
        onPress={onToggle}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: webSpace(2),
          paddingHorizontal: TURN_SPACE.cardPad,
          paddingVertical: webSpace(1.5),
          backgroundColor: pressed ? palette.muted20Bg : undefined,
        })}
      >
        <ToolCaret open={open} color={palette.muted40} size={META_ICON} />
        <Glyph size={TURN_SPACE.statusIcon} color={palette.muted60} />
        <Text variant="small" style={[TURN_TYPE.xs, { fontFamily: FONT_MEDIUM, color: palette.foreground }]}>
          {label}
        </Text>
        <Text variant="muted" style={[TURN_TYPE.xs, { marginLeft: 'auto', color: palette.muted50 }]}>
          {count}
        </Text>
      </PressableSurface>
      <DisclosureContent open={open}>{children}</DisclosureContent>
    </View>
  );
}

function TodoBox({ status }: { status: string }) {
  const palette = useTurnPalette();
  const isComplete = status === 'completed';
  const isProgress = status === 'in_progress';
  return (
    <View
      style={{
        marginTop: 2,
        width: webSpace(3),
        height: webSpace(3),
        flexShrink: 0,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 4,
        borderWidth: 1,
        borderColor: isComplete ? palette.successBorder : isProgress ? palette.infoBorder : palette.border,
        backgroundColor: isComplete ? palette.successBg : undefined,
      }}
    >
      {isComplete ? <CheckIcon size={webSpace(2)} color={palette.success} /> : null}
      {isProgress ? (
        <View style={{ width: webSpace(2), height: webSpace(2), borderRadius: webSpace(1), backgroundColor: palette.info }} />
      ) : null}
    </View>
  );
}

export function SessionGetTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const palette = useTurnPalette();
  const input = partInput(part);
  const output = partOutput(part);
  const sid = (input.session_id as string) || '';

  const parsed = useMemo(() => parseSessionGetOutput(output, sid), [output, sid]);
  const headerArgs = useMemo(() => sessionGetHeaderArgs(parsed), [parsed]);
  const outputIsError = useMemo(() => isErrorOutput(output), [output]);

  const [showConv, setShowConv] = useState(false);
  const [showTodos, setShowTodos] = useState(true);

  const divider = { borderTopWidth: 1, borderTopColor: palette.border20 };

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={BookOpenIcon}
      trigger={{ title: parsed?.title ?? 'Session Get', subtitle: parsed?.id || sid, args: headerArgs }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {outputIsError ? (
        <ToolOutputFallback output={output} toolName="session_get" />
      ) : parsed ? (
        <View>
          <View
            style={{
              flexDirection: 'row',
              flexWrap: 'wrap',
              columnGap: webSpace(4),
              rowGap: webSpace(1),
              paddingHorizontal: TURN_SPACE.cardPad,
              paddingVertical: webSpace(2.5),
            }}
          >
            {parsed.id ? <MetaItem mono>{parsed.id}</MetaItem> : null}
            {parsed.created ? <MetaItem icon={ClockIcon}>{parsed.created}</MetaItem> : null}
            {parsed.updated && parsed.updated !== parsed.created ? (
              <MetaItem icon={ArrowClockwiseIcon}>{parsed.updated}</MetaItem>
            ) : null}
            {parsed.changes ? <MetaItem icon={FileTextIcon}>{parsed.changes}</MetaItem> : null}
            {parsed.parent ? <MetaItem mono>{`Parent: ${parsed.parent}`}</MetaItem> : null}
          </View>

          {parsed.todos.length > 0 ? (
            <View style={divider}>
              <SectionFold
                open={showTodos}
                onToggle={() => setShowTodos((v) => !v)}
                icon={ListChecksIcon}
                label="Todos"
                count={String(parsed.todos.length)}
              >
                <View style={{ rowGap: webSpace(1), paddingHorizontal: TURN_SPACE.cardPad, paddingBottom: webSpace(2) }}>
                  {parsed.todos.map((todo) => (
                    <View key={todo.text} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: webSpace(2) }}>
                      <TodoBox status={todo.status} />
                      <Text
                        variant="muted"
                        style={[
                          SNUG,
                          { flexShrink: 1, color: palette.foreground },
                          todo.status === 'completed' && { color: palette.muted50, textDecorationLine: 'line-through' },
                          todo.status === 'in_progress' && { fontFamily: FONT_MEDIUM },
                        ]}
                      >
                        {todo.text}
                      </Text>
                    </View>
                  ))}
                </View>
              </SectionFold>
            </View>
          ) : null}

          {parsed.hasConversation && parsed.conversation ? (
            <View style={divider}>
              <SectionFold
                open={showConv}
                onToggle={() => setShowConv((v) => !v)}
                icon={ChatCircleIcon}
                label="Conversation"
                count={`${parsed.msgCount} msgs · ${parsed.toolCount} tools`}
              >
                <View style={{ paddingHorizontal: TURN_SPACE.cardPad, paddingVertical: webSpace(2) }}>
                  <OutputBlock text={parsed.conversation} markdown />
                </View>
              </SectionFold>
            </View>
          ) : null}

          {parsed.compression ? (
            <View
              style={[
                divider,
                {
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: webSpace(2),
                  paddingHorizontal: TURN_SPACE.cardPad,
                  paddingVertical: webSpace(2),
                },
              ]}
            >
              <ArrowsInSimpleIcon size={META_ICON} color={palette.muted40} />
              <Text variant="muted" style={[TURN_TYPE.xs, { flexShrink: 1, color: palette.muted40 }]}>
                {parsed.compression}
              </Text>
            </View>
          ) : null}

          {!parsed.hasConversation && parsed.todos.length === 0 ? (
            <View style={[divider, { paddingHorizontal: TURN_SPACE.cardPad, paddingVertical: webSpace(3) }]}>
              <Text
                variant="muted"
                style={[TURN_TYPE.xs, { textAlign: 'center', fontStyle: 'italic', color: palette.muted40 }]}
              >
                No messages in this session
              </Text>
            </View>
          ) : null}
        </View>
      ) : output ? (
        <ToolOutputFallback output={output} toolName="session_get" />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('session_get', SessionGetTool);
ToolRegistry.register('session-get', SessionGetTool);
ToolRegistry.register('oc-session_get', SessionGetTool);
ToolRegistry.register('oc-session-get', SessionGetTool);

// ─── Legacy body (imported by tool-part-renderer.tsx) ────────────────────────

export interface SessionGetData {
  title: string;
  id: string;
  created: string;
  updated: string;
  changes: string;
  parent: string | null;
  todos: Array<{ status: 'completed' | 'in_progress' | 'pending'; text: string }>;
  messageCount: string;
  toolCallCount: string;
  compressionNote: string | null;
  hasConversation: boolean;
}

export function parseSessionGet(output: string): SessionGetData | null {
  if (!output || typeof output !== 'string') return null;
  const titleMatch = output.match(/^=== SESSION:\s*(.+?)\s*===$/m);
  if (!titleMatch) return null;

  const idMatch = output.match(/^ID:\s*(ses_\S+)/m);
  const createdMatch = output.match(/Created:\s*(\S+ \S+)/);
  const updatedMatch = output.match(/Updated:\s*(\S+ \S+)/);
  const changesMatch = output.match(/Changes:\s*(.+)/m);
  const parentMatch = output.match(/Parent:\s*(ses_\S+)/m);

  // Todos
  const todosSection = output.match(/^Todos:\n([\s\S]*?)(?=\n(?:Lineage|Storage|===))/m);
  const todos: SessionGetData['todos'] = [];
  if (todosSection) {
    for (const line of todosSection[1].split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === '(none)') continue;
      const statusMatch = trimmed.match(/^\[(\w+)\]\s*(.*)/);
      if (statusMatch) {
        const s = statusMatch[1] as string;
        const status = s === 'completed' ? 'completed' : s === 'in_progress' ? 'in_progress' : 'pending';
        todos.push({ status, text: statusMatch[2] });
      } else {
        todos.push({ status: 'pending', text: trimmed });
      }
    }
  }

  // Conversation header
  const convHeader = output.match(/=== CONVERSATION \((\d+) msgs?, (\d+) tool calls?/);
  const compressionMatch = output.match(/=== COMPRESSION ===\n(.+)/m);

  return {
    title: titleMatch[1],
    id: idMatch?.[1] ?? '',
    created: createdMatch?.[1] ?? '',
    updated: updatedMatch?.[1] ?? '',
    changes: changesMatch?.[1] ?? 'no changes',
    parent: parentMatch?.[1] ?? null,
    todos,
    messageCount: convHeader?.[1] ?? '0',
    toolCallCount: convHeader?.[2] ?? '0',
    compressionNote: compressionMatch?.[1]?.trim() ?? null,
    hasConversation: !!convHeader,
  };
}

export function SessionGetExpandedContent({ tool, isDark }: { tool: ToolPart; isDark: boolean }) {
  const output = useMemo(() => {
    if (tool.state.status === 'completed' && 'output' in tool.state && tool.state.output) {
      return stripAnsi(tool.state.output).trim();
    }
    return '';
  }, [tool.state]);

  const data = useMemo(() => parseSessionGet(output), [output]);

  if (!data) {
    // Fallback to generic
    return output ? (
      <View style={{ paddingHorizontal: 12, paddingVertical: 10, maxHeight: 250 }}>
        <MonoBlock isDark={isDark} maxLines={30}>
          {output.length > 3000 ? output.slice(0, 3000) + '\n...' : output}
        </MonoBlock>
      </View>
    ) : null;
  }

  const metaColor = muted(isDark);
  const metaFs = 11;

  return (
    <ToolScroll maxHeight={400} showsVerticalScrollIndicator>
      <View style={{ padding: 12, gap: 10 }}>
        {/* Session title */}
        <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: fg(isDark), lineHeight: 20 }}>
          {data.title}
        </Text>

        {/* Metadata grid */}
        <View style={{ gap: 4 }}>
          {/* ID */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={{ fontSize: 9, fontFamily: monoFont, color: metaColor, opacity: 0.7 }}>
              {data.id}
            </Text>
          </View>

          {/* Timestamps */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Text style={{ fontSize: metaFs, fontFamily: 'Roobert', color: metaColor }}>
              Created {data.created}
            </Text>
            {data.updated && data.updated !== data.created && (
              <Text style={{ fontSize: metaFs, fontFamily: 'Roobert', color: metaColor }}>
                Updated {data.updated}
              </Text>
            )}
          </View>

          {/* Changes + Messages */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <Text style={{ fontSize: metaFs, fontFamily: 'Roobert', color: metaColor }}>
              {data.changes}
            </Text>
            {data.hasConversation && (
              <Text style={{ fontSize: metaFs, fontFamily: 'Roobert', color: metaColor }}>
                {data.messageCount} msgs · {data.toolCallCount} tool calls
              </Text>
            )}
          </View>

          {/* Parent */}
          {data.parent && (
            <Text style={{ fontSize: metaFs, fontFamily: 'Roobert', color: metaColor }}>
              Parent: <Text style={{ fontFamily: monoFont, fontSize: 10 }}>{data.parent}</Text>
            </Text>
          )}
        </View>

        {/* Todos */}
        {data.todos.length > 0 && (
          <View
            style={{
              borderRadius: 8,
              borderWidth: 1,
              borderColor: isDark ? withAlpha(THEME.dark.foreground, 0.06) : withAlpha(THEME.light.foreground, 0.06),
              backgroundColor: isDark ? withAlpha(THEME.dark.foreground, 0.02) : withAlpha(THEME.light.foreground, 0.015),
              padding: 10,
              gap: 6,
            }}
          >
            <Text style={{ fontSize: 10, fontFamily: 'Roobert-Medium', color: mutedStrong(isDark), textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Todos ({data.todos.length})
            </Text>
            {data.todos.map((todo, i) => (
              <View key={i} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6 }}>
                <View
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 3,
                    borderWidth: 1.5,
                    marginTop: 1,
                    borderColor: todo.status === 'completed'
                      ? (THEME.accent.green)
                      : todo.status === 'in_progress'
                      ? (THEME.accent.blue)
                      : (isDark ? THEME.dark.border : THEME.light.border),
                    backgroundColor: todo.status === 'completed'
                      ? (isDark ? withAlpha(THEME.accent.green, 0.15) : withAlpha(THEME.accent.green, 0.1))
                      : 'transparent',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {todo.status === 'completed' && (
                    <Text style={{ fontSize: 9, color: THEME.accent.green, fontWeight: '700' }}>✓</Text>
                  )}
                  {todo.status === 'in_progress' && (
                    <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: THEME.accent.blue }} />
                  )}
                </View>
                <Text
                  style={{
                    flex: 1,
                    fontSize: 12,
                    fontFamily: 'Roobert',
                    lineHeight: 17,
                    color: todo.status === 'completed' ? muted(isDark) : fg(isDark),
                    textDecorationLine: todo.status === 'completed' ? 'line-through' : 'none',
                  }}
                >
                  {todo.text}
                </Text>
              </View>
            ))}
          </View>
        )}

        {/* Compression badge */}
        {data.compressionNote && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <View
              style={{
                paddingHorizontal: 6,
                paddingVertical: 2,
                borderRadius: 4,
                backgroundColor: isDark ? withAlpha(THEME.accent.green, 0.12) : withAlpha(THEME.accent.green, 0.08),
              }}
            >
              <Text style={{ fontSize: 10, fontFamily: 'Roobert-Medium', color: THEME.accent.green }}>
                Compressed
              </Text>
            </View>
            <Text style={{ fontSize: 10, fontFamily: 'Roobert', color: muted(isDark) }}>
              {data.compressionNote}
            </Text>
          </View>
        )}

        {/* No messages indicator */}
        {!data.hasConversation && (
          <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: muted(isDark), fontStyle: 'italic' }}>
            No messages in this session
          </Text>
        )}
      </View>
    </ToolScroll>
  );
}
