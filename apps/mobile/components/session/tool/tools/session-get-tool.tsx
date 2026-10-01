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
 */

import { useMemo, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { PressableSurface } from '@/components/kortix/pressable-surface';
import { Text } from '@/components/ui/text';
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
import { OutputBlock } from '../shared/output-block';
import { ToolCaret, ToolScroll } from '../shared/surface';
import type { ToolProps } from '../shared/types';
import { FONT_MEDIUM, TURN_SPACE, TURN_TYPE, fg, monoFont, muted, mutedStrong, useTurnPalette } from '../shared/styles';

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
ToolRegistry.register('session-get', SessionGetTool);
