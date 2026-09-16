/**
 * `todowrite` — the plan checklist. Port of apps/web `tool/tools/todo-write-tool.tsx`.
 *
 * - trigger: `ListChecks` · "Todos" · subtitle = the in-progress item, else
 *   "N of M done"; badge "done/total";
 * - body: a `kortix-green` progress bar (`h-1 mb-3`, track `bg-primary/[0.08]`),
 *   then a vertical stepper — status glyph over a `w-0.5` connector
 *   (`bg-border`, `kortix-green/40` once that step is done, none after the last
 *   step) beside `text-xs leading-snug` text styled by status; or "No tasks yet".
 *
 * Web hides `todowrite` parts from the transcript because its Plan card shows
 * the plan. Mobile has no Plan card, so the row renders in the transcript.
 *
 * `TodosExpandedContent` below is the previous mobile body, kept because
 * `tool-part-renderer.tsx` still imports it.
 */

import { useMemo } from 'react';
import { View } from 'react-native';
import { useColorScheme } from 'nativewind';
import { Progress } from '@/components/ui/progress';
import { Text } from '@/components/ui/text';
import { THEME, withAlpha } from '@/lib/utils/theme';
import type { ToolPart } from '@/lib/opencode/types';
import {
  CheckCircleIcon,
  DotsThreeCircleIcon,
  CircleIcon,
  ListChecksIcon,
  XCircleIcon,
  type AppIcon,
} from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { selectTodos, todoProgress } from '@/lib/session/tools/agents-todo';
import { webSpace } from '@/lib/session/user-message';
import {
  BasicTool,
  ToolEmptyState,
  partInput,
  partMetadata,
  partStreamingInput,
} from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { FONT_MEDIUM, TURN_TYPE, fg, muted, useTurnPalette } from '../shared/styles';
import { TodoStatusIcon } from '../shared/todo-helpers';
import type { ToolProps } from '../shared/types';
import { getToolInput } from '../shared/tool-part';

/** `text-xs leading-snug` (1.375). */
const TODO_TEXT = { fontSize: TURN_TYPE.xs.fontSize, lineHeight: TURN_TYPE.xs.fontSize * 1.375 };

export function TodoWriteTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const palette = useTurnPalette();
  const { colorScheme } = useColorScheme();
  const input = partInput(part);
  const streamingInput = partStreamingInput(part);
  const metadata = partMetadata(part);

  const todos = useMemo(
    () => selectTodos({ input, metadata, streamingInput }),
    [input, metadata, streamingInput],
  );
  const { total, pct, keyed, subtitle, badge } = useMemo(() => todoProgress(todos), [todos]);
  const track = withAlpha(THEME[colorScheme === 'dark' ? 'dark' : 'light'].primary, 0.08);

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={ListChecksIcon}
      trigger={{ title: 'Todos', subtitle }}
      badge={badge}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {total > 0 ? (
        <View>
          <Progress
            value={pct}
            className="mb-3 h-1"
            style={{ backgroundColor: track }}
            indicatorClassName="bg-kortix-green"
          />
          <View style={{ width: '100%' }}>
            {keyed.map(({ todo, key }, i) => {
              const last = i + 1 >= total;
              return (
                <View key={key} style={{ flexDirection: 'row', gap: webSpace(2.5) }}>
                  <View style={{ alignItems: 'center', alignSelf: 'stretch' }}>
                    <View style={{ marginTop: 1, flexShrink: 0, alignItems: 'center', justifyContent: 'center' }}>
                      <TodoStatusIcon status={todo.status} />
                    </View>
                    {last ? null : (
                      <View
                        style={{
                          flex: 1,
                          minHeight: webSpace(1),
                          width: webSpace(0.5),
                          marginVertical: webSpace(0.5),
                          backgroundColor:
                            todo.status === 'completed' ? withAlpha(palette.kortixGreen, 0.4) : palette.border,
                        }}
                      />
                    )}
                  </View>
                  <Text
                    variant="muted"
                    style={[
                      TODO_TEXT,
                      { flex: 1, minWidth: 0, paddingBottom: last ? 0 : webSpace(3) },
                      todo.status === 'completed' && {
                        color: palette.muted60,
                        textDecorationLine: 'line-through',
                      },
                      todo.status === 'in_progress' && { color: palette.foreground, fontFamily: FONT_MEDIUM },
                      todo.status === 'pending' && { color: palette.mutedForeground },
                      todo.status === 'cancelled' && {
                        color: palette.muted40,
                        textDecorationLine: 'line-through',
                      },
                    ]}
                  >
                    {todo.content}
                  </Text>
                </View>
              );
            })}
          </View>
        </View>
      ) : (
        <ToolEmptyState message="No tasks yet" />
      )}
    </BasicTool>
  );
}
ToolRegistry.register('todowrite', TodoWriteTool);
ToolRegistry.register('todo_write', TodoWriteTool);
ToolRegistry.register('todo-write', TodoWriteTool);

// ─── Legacy body (imported by tool-part-renderer.tsx) ────────────────────────

export function TodosExpandedContent({ tool, isDark }: { tool: ToolPart; isDark: boolean }) {
  const todos = useMemo(() => {
    // Try parsing input.todos (check both state.input and top-level input)
    const input = getToolInput(tool);
    const raw = input.todos;
    if (Array.isArray(raw)) return raw;
    // Try parsing output
    if (tool.state.status === 'completed' && 'output' in tool.state && tool.state.output) {
      try {
        const parsed = JSON.parse(tool.state.output);
        if (Array.isArray(parsed)) return parsed;
        if (parsed?.todos && Array.isArray(parsed.todos)) return parsed.todos;
      } catch {}
    }
    return [];
  }, [tool.input, tool.state]);

  if (todos.length === 0) return null;

  const statusIcons: Record<string, { icon: AppIcon; color: string; solid?: boolean }> = {
    completed: { icon: CheckCircleIcon, color: THEME.accent.green, solid: true },
    in_progress: { icon: DotsThreeCircleIcon, color: THEME.accent.blue },
    pending: { icon: CircleIcon, color: muted(isDark) },
    cancelled: { icon: XCircleIcon, color: muted(isDark) },
  };

  return (
    <View style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
      {todos.map((todo: any, i: number) => {
        const st = statusIcons[todo.status] || statusIcons.pending;
        return (
          <View
            key={i}
            style={{
              flexDirection: 'row',
              alignItems: 'flex-start',
              paddingVertical: 5,
              borderBottomWidth: i < todos.length - 1 ? 1 : 0,
              borderBottomColor: isDark ? withAlpha(THEME.dark.foreground, 0.04) : withAlpha(THEME.light.foreground, 0.03),
            }}
          >
            <st.icon
              size={16}
              color={st.color}
              weight={st.solid ? 'fill' : undefined}
              style={{ marginRight: 8, marginTop: 1 }}
            />
            <View style={{ flex: 1 }}>
              <Text
                style={{
                  fontSize: 12,
                  fontFamily: 'Roobert',
                  lineHeight: 18,
                  color: todo.status === 'cancelled' ? muted(isDark) : fg(isDark),
                  textDecorationLine: todo.status === 'cancelled' ? 'line-through' : 'none',
                }}
              >
                {todo.content}
              </Text>
              {todo.priority && (
                <Text style={{ fontSize: 10, fontFamily: 'Roobert', color: muted(isDark), marginTop: 1 }}>
                  {todo.priority}
                </Text>
              )}
            </View>
          </View>
        );
      })}
    </View>
  );
}
