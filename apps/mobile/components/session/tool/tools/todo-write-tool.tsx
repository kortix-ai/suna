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
 */

import { useMemo } from 'react';
import { View } from 'react-native';
import { useColorScheme } from 'nativewind';
import { Progress } from '@/components/ui/progress';
import { Text } from '@/components/ui/text';
import { THEME, withAlpha } from '@/lib/utils/theme';
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
ToolRegistry.register('todo-write', TodoWriteTool);
