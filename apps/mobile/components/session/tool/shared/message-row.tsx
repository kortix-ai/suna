/**
 * One agent-to-agent message as a plain tool row (port of apps/web
 * `PeerSendRow` and `PeerMessageRow`): the other agent's pixel mark as the
 * icon, who it was to or from, one line, and a state at the right edge. Open,
 * the whole text under a thin left rule. Never a card of its own.
 */

import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { AgentPixelMark, agentSlugOfHandle } from './agent-pixel-mark';
import { BasicTool } from './infrastructure';
import { TURN_TYPE, useTurnPalette } from './styles';
import { webSpace } from '@/lib/session/user-message';

export function MessageRow({
  handle,
  title,
  subtitle,
  state,
  stateTone = 'muted',
  text,
  testID,
}: {
  /** The other agent's handle: its face is the row's icon. */
  handle: string | null;
  title: string;
  subtitle?: string | null;
  /** A word at the right edge ("Delivered", "Not sent"). */
  state?: string;
  stateTone?: 'muted' | 'failed';
  /** The full text the row opens onto; nothing to open without it. */
  text?: string | null;
  testID?: string;
}) {
  const palette = useTurnPalette();
  const body = text?.trim() ? (
    <View style={{ marginLeft: webSpace(1.5), paddingLeft: webSpace(3), borderLeftWidth: 1, borderLeftColor: palette.border }}>
      <Text selectable style={[TURN_TYPE.sm, { color: palette.foreground }]}>
        {text}
      </Text>
    </View>
  ) : undefined;
  return (
    <View testID={testID}>
      <BasicTool
        icon={handle ? <AgentPixelMark slug={agentSlugOfHandle(handle)} size={14} tile={16} /> : undefined}
        trigger={
          <>
            <Text numberOfLines={1} style={[TURN_TYPE.sm, { flexShrink: 0, maxWidth: '60%', color: palette.foreground }]}>
              {title}
            </Text>
            {subtitle ? (
              <Text numberOfLines={1} style={[TURN_TYPE.sm, { flex: 1, color: palette.mutedForeground }]}>
                {subtitle}
              </Text>
            ) : (
              <View style={{ flex: 1 }} />
            )}
            {state ? (
              <Text style={[TURN_TYPE.xs, { flexShrink: 0, color: stateTone === 'failed' ? palette.destructive : palette.mutedForeground }]}>
                {state}
              </Text>
            ) : null}
          </>
        }
      >
        {body}
      </BasicTool>
    </View>
  );
}
