/**
 * Session tool helpers (`session_list`, `session_get`, bash session dumps).
 *
 * Mirrors apps/web `tool/shared/session-helpers.tsx`. The parsers live in
 * `lib/session/tool-output-parsers.ts` and are re-exported here.
 * - `SessionTimeLabel` — relative time, refreshed every 60 s;
 * - `SessionMetadataList` — `flex-col gap-1 p-1.5`; a `text-xs font-medium
 *   uppercase tracking-wider` count header; one row per session (`gap-2.5
 *   rounded-md px-2.5 py-2`, `ChatCircle` `size-3.5`, title `text-xs
 *   font-medium`, `DiffStat` + file count, mono slug · time) that opens the
 *   session (mobile: `navigateToSession`);
 * - `InlineSessionMessagesList` — one `rounded-md border` card per message:
 *   role header (`bg-muted/50` user / `bg-card` assistant, role in the info /
 *   success tone, `#index`, `$cost` to 4 places), content capped at 800
 *   characters, and tool chips (success-toned when completed).
 */

import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/ui/text';
import { ArrowSquareOutIcon, ChatCircleIcon } from '@/lib/icons';
import {
  formatSessionTime,
  formatSessionTimeFallback,
  type ParsedSessionMessage,
  type ParsedSessionMeta,
} from '@/lib/session/tool-output-parsers';
import { webSpace } from '@/lib/session/user-message';
import { DiffStat } from './infrastructure';
import { useToolNavigation } from './navigation';
import { FONT_MEDIUM, FONT_SEMIBOLD, TURN_SPACE, TURN_TYPE, monoFont, useTurnPalette } from './styles';

export {
  formatBashOutput,
  formatSessionTime,
  formatSessionTimeFallback,
  parseSessionMessagesOutput,
  parseSessionMetadataOutput,
  type ParsedSessionMessage,
  type ParsedSessionMeta,
} from '@/lib/session/tool-output-parsers';

export function SessionTimeLabel({ timestamp }: { timestamp: number }) {
  const palette = useTurnPalette();
  const [label, setLabel] = useState(() => formatSessionTimeFallback(timestamp));
  useEffect(() => {
    const update = () => setLabel(formatSessionTime(timestamp));
    update();
    const id = setInterval(update, 60_000);
    return () => clearInterval(id);
  }, [timestamp]);
  return (
    <Text variant="muted" style={[TURN_TYPE.xs, { color: palette.mutedForeground }]}>
      {label}
    </Text>
  );
}

function CountHeader({ children }: { children: string }) {
  const palette = useTurnPalette();
  return (
    <Text
      variant="small"
      style={[
        TURN_TYPE.xs,
        {
          paddingHorizontal: webSpace(1.5),
          paddingVertical: webSpace(1),
          fontFamily: FONT_MEDIUM,
          letterSpacing: 0.65,
          textTransform: 'uppercase',
          color: palette.mutedForeground,
        },
      ]}
    >
      {children}
    </Text>
  );
}

export function SessionMetadataList({ sessions }: { sessions: ParsedSessionMeta[] }) {
  const palette = useTurnPalette();
  const { enabled: navigationEnabled, openSession } = useToolNavigation();

  return (
    <View style={{ rowGap: webSpace(1), padding: webSpace(1.5) }}>
      <CountHeader>{`${sessions.length} session${sessions.length !== 1 ? 's' : ''}`}</CountHeader>
      {sessions.map((s) => (
        <Pressable
          key={s.id}
          accessibilityRole="button"
          accessibilityLabel={s.title || 'Session'}
          disabled={!navigationEnabled}
          onPress={() => openSession(s.id)}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: webSpace(2.5),
            borderRadius: TURN_SPACE.radiusMd,
            paddingHorizontal: webSpace(2.5),
            paddingVertical: webSpace(2),
            opacity: navigationEnabled ? 1 : 0.7,
            backgroundColor: pressed ? palette.muted60Bg : undefined,
          })}
        >
          <View style={{ marginTop: webSpace(0.5) }}>
            <ChatCircleIcon size={TURN_SPACE.caret} color={palette.mutedForeground} />
          </View>
          <View style={{ flex: 1, minWidth: 0, rowGap: webSpace(0.5) }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: webSpace(2) }}>
              <Text
                variant="small"
                numberOfLines={1}
                style={[TURN_TYPE.xs, { flexShrink: 1, fontFamily: FONT_MEDIUM, color: palette.foreground }]}
              >
                {s.title}
              </Text>
              {s.summary && s.summary.files > 0 ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: TURN_SPACE.gap1_5, flexShrink: 0 }}>
                  <DiffStat additions={s.summary.additions} deletions={s.summary.deletions} />
                  <Text variant="muted" style={[TURN_TYPE.xs, { color: palette.mutedForeground }]}>
                    {s.summary.files} file{s.summary.files !== 1 ? 's' : ''}
                  </Text>
                </View>
              ) : null}
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: webSpace(2) }}>
              <Text
                variant="muted"
                numberOfLines={1}
                style={[TURN_TYPE.xs, { flexShrink: 1, fontFamily: monoFont, color: palette.mutedForeground }]}
              >
                {s.slug || s.id}
              </Text>
              <SessionTimeLabel timestamp={s.time.updated} />
            </View>
          </View>
          <View style={{ marginTop: webSpace(1) }}>
            <ArrowSquareOutIcon size={TURN_SPACE.statusIcon} color={palette.muted40} />
          </View>
        </Pressable>
      ))}
    </View>
  );
}

export function InlineSessionMessagesList({ messages }: { messages: ParsedSessionMessage[] }) {
  const palette = useTurnPalette();
  return (
    <View style={{ rowGap: webSpace(1), padding: webSpace(1.5) }}>
      <CountHeader>{`${messages.length} message${messages.length !== 1 ? 's' : ''}`}</CountHeader>
      {messages.map((msg) => {
        const isUser = msg.role === 'user';
        return (
          <View
            key={msg.index}
            style={{
              overflow: 'hidden',
              borderRadius: TURN_SPACE.radiusMd,
              borderWidth: 1,
              borderColor: isUser ? palette.border60 : palette.border40,
            }}
          >
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: webSpace(2),
                paddingHorizontal: webSpace(2.5),
                paddingVertical: webSpace(1),
                backgroundColor: isUser ? palette.mutedHalf : palette.card,
              }}
            >
              <Text
                variant="small"
                style={[
                  TURN_TYPE.xs,
                  { fontFamily: FONT_SEMIBOLD, letterSpacing: 0.33, textTransform: 'uppercase', color: isUser ? palette.info : palette.success },
                ]}
              >
                {msg.role}
              </Text>
              <Text variant="muted" style={[TURN_TYPE.xs, { marginLeft: 'auto', color: palette.muted50 }]}>
                #{msg.index}
              </Text>
              {msg.cost > 0 ? (
                <Text variant="muted" style={[TURN_TYPE.xs, { color: palette.muted50 }]}>
                  ${msg.cost.toFixed(4)}
                </Text>
              ) : null}
            </View>
            <View style={{ paddingHorizontal: webSpace(2.5), paddingVertical: webSpace(1.5) }}>
              <Text variant="muted" selectable style={[TURN_TYPE.xsRelaxed, { color: palette.foreground90 }]}>
                {msg.content.slice(0, 800)}
                {msg.content.length > 800 ? <Text variant="muted" style={{ color: palette.muted50 }}> …truncated</Text> : null}
              </Text>
              {msg.tools ? (
                <View style={{ marginTop: webSpace(1), flexDirection: 'row', flexWrap: 'wrap', gap: webSpace(1) }}>
                  {msg.tools.split(',').map((t, i) => {
                    const trimmedTool = t.trim();
                    const nameMatch = trimmedTool.match(/^(\w+)\s*\((\w+)\)/);
                    const name = nameMatch?.[1] || trimmedTool;
                    const completed = nameMatch?.[2] === 'completed';
                    return (
                      <View
                        key={i}
                        style={{
                          borderRadius: 4,
                          borderWidth: 1,
                          paddingHorizontal: webSpace(1),
                          paddingVertical: webSpace(0.5),
                          borderColor: completed ? palette.successBorder : palette.border50,
                          backgroundColor: completed ? palette.successBg : palette.mutedHalf,
                        }}
                      >
                        <Text variant="muted" style={[TURN_TYPE.xs, { color: completed ? palette.success : palette.mutedForeground }]}>
                          {name}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}
