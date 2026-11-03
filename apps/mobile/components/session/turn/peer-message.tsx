/**
 * A message one agent sent another, delivered into this session as a prompt.
 * Nobody here typed it, so it is never a user bubble. Port of apps/web
 * `session/turn/peer-message-row.tsx`:
 *
 *   message, shutdown request/answer  a plain tool row: the sender's face, who sent it,
 *                                     the first line; the whole text unfolds under it
 *   idle notice                       an event, not a message: the finish line
 */

import { peerHandleLabel, type PeerMessagePromptInfo } from '@kortix/shared';
import { Text } from '@/components/ui/text';
import { SessionStatusMark } from '@/components/session/SessionStatusMark';
import { peerHeadline, peerMessagePreview } from '@/lib/session/multi-agent';
import { View } from 'react-native';
import { FinishLine } from '@/components/session/tool/shared/agent-surface';
import { MessageRow } from '@/components/session/tool/shared/message-row';
import { TURN_TYPE, useTurnPalette } from '@/components/session/tool/shared/styles';

export function PeerMessage({ info }: { info: PeerMessagePromptInfo }) {
  const palette = useTurnPalette();
  const from = peerHandleLabel(info.from);
  const headline = peerHeadline(info.kind, from);
  const preview = peerMessagePreview(info);
  const expandable = info.text.trim().length > 0 && info.text.trim() !== preview;

  if (info.kind === 'idle_notice') {
    return (
      <View testID="peer-message" className="px-4">
        <FinishLine mark={<SessionStatusMark status="done" />}>
          <Text numberOfLines={1} style={[TURN_TYPE.xs, { flexShrink: 0, color: palette.foreground }]}>
            {headline}
          </Text>
          {preview ? (
            <>
              <Text style={[TURN_TYPE.xs, { color: palette.mutedForeground }]}>·</Text>
              <Text numberOfLines={1} style={[TURN_TYPE.xs, { flexShrink: 1, color: palette.mutedForeground }]}>
                {preview}
              </Text>
            </>
          ) : null}
        </FinishLine>
      </View>
    );
  }

  // One plain tool row: the sender's face, who sent it, the first line; open, the whole text.
  return (
    <View testID="peer-message" className="px-4">
      <MessageRow
        testID="peer-message-row"
        handle={info.from}
        title={headline}
        subtitle={preview}
        text={expandable ? info.text : null}
      />
    </View>
  );
}
