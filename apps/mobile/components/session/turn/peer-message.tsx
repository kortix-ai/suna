/**
 * A message one agent sent another, delivered into this session as a prompt.
 * Nobody here typed it, so it is never a user bubble. Port of apps/web
 * `session/turn/peer-message-row.tsx`: one agent row, the sender's face and
 * handle; a message's text shows on the rail, open. An idle notice is a
 * finish row that opens to the rest.
 */

import { peerHandleLabel, type PeerMessagePromptInfo } from '@kortix/shared';
import { View } from 'react-native';
import { peerMessagePreview } from '@kortix/sdk';
import { AgentRow } from '@/components/session/tool/shared/message-row';

const KIND_WORD: Record<PeerMessagePromptInfo['kind'], string> = {
  message: 'Message',
  idle_notice: 'Finished',
  shutdown_request: 'Asks to stop',
  shutdown_response: 'Stop answer',
};

/** An idle notice's text without the line that repeats the state word, and its answer without its label (web `idleNoticeBody`). */
function idleBody(text: string): string {
  // Only the platform's two lines change; the answer itself keeps its Markdown (indents, blank lines).
  return text
    .split('\n')
    .filter((line) => !/finished its turn and is idle\.?\s*$/.test(line))
    .map((line) => line.replace(/^(\s*)Its last answer:\s?/, '$1'))
    .join('\n')
    .trim();
}

export function PeerMessage({ info }: { info: PeerMessagePromptInfo }) {
  const idle = info.kind === 'idle_notice';
  const preview = peerMessagePreview(info);
  const text = info.text.trim();
  return (
    <View testID="peer-message" className="px-4">
      <AgentRow
        testID="peer-message-row"
        handle={info.from}
        title={peerHandleLabel(info.from).replace(/^@/, '')}
        subtitle={idle ? preview || null : info.summary?.trim() || null}
        state={KIND_WORD[info.kind]}
        glyph={idle ? 'done' : undefined}
        text={idle ? idleBody(text) : text}
        defaultOpen={!idle}
      />
    </View>
  );
}
