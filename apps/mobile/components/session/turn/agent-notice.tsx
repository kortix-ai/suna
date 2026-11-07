/**
 * A finish notice in place of the user bubble: nobody typed this turn. Port of
 * apps/web `session/turn/subagent-notice-row.tsx` + `notice-batch-group.tsx`:
 * one agent row, the same row as the call that started it.
 *
 *   [face] pricing-scout  Three of five raised prices…        ✓ Finished
 *          │ the whole report (Markdown) · Open ↗
 *
 * A batch is the same rows, stacked. A failure says so in one sentence.
 */

import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { NOTICE_GLYPH, noticeExcerpt, noticeName, noticeReport, type AgentNoticePrompt } from '@/lib/session/agent-notice';
import { webSpace } from '@/lib/session/user-message';
import { AgentRow, AgentRowBody, OpenAgentAction } from '@/components/session/tool/shared/message-row';
import { OutputBlock } from '@/components/session/tool/shared/output-block';
import { TURN_TYPE, useTurnPalette } from '@/components/session/tool/shared/styles';
import type { SubagentNotice } from '@kortix/sdk';
import { PeerMessage } from './peer-message';

const STATE_WORD: Record<SubagentNotice['status'], string> = {
  completed: 'Finished',
  failed: 'Didn’t finish',
  stopped: 'Stopped',
};

export function AgentNotice({ prompt, onOpenSession }: { prompt: AgentNoticePrompt; onOpenSession?: (sessionId: string) => void }) {
  if (prompt.kind === 'single') {
    return (
      <View testID="agent-notice" className="px-4">
        <NoticeRow notice={prompt.notice} onOpenSession={onOpenSession} />
      </View>
    );
  }
  return (
    <View testID="agent-notice" style={{ gap: webSpace(1) }}>
      {prompt.items.map((item, index) =>
        item.kind === 'peer_idle' ? (
          <PeerMessage key={`peer-${item.info.messageId}`} info={{ ...item.info, kind: 'idle_notice' }} />
        ) : (
          <View key={`${item.notice.sessionId}-${index}`} className="px-4">
            <NoticeRow notice={item.notice} onOpenSession={onOpenSession} />
          </View>
        ),
      )}
    </View>
  );
}

function NoticeRow({ notice, onOpenSession }: { notice: SubagentNotice; onOpenSession?: (sessionId: string) => void }) {
  const palette = useTurnPalette();
  const report = noticeReport(notice.result);
  const failed = notice.status === 'failed';
  const name = noticeName(notice);
  const excerpt = noticeExcerpt(report);
  return (
    <AgentRow
      testID="agent-notice-row"
      handle={notice.handle ?? notice.agent ?? 'general'}
      title={name}
      subtitle={notice.ownedTasks ? `Still owns ${notice.ownedTasks}` : failed ? notice.title : (excerpt ?? notice.title)}
      state={STATE_WORD[notice.status]}
      glyph={NOTICE_GLYPH[notice.status]}
      body={
        <AgentRowBody>
          {failed ? (
            <Text style={[TURN_TYPE.sm, { color: palette.foreground }]}>The agent stopped before it finished.</Text>
          ) : report ? (
            <OutputBlock text={report} markdown />
          ) : null}
          {onOpenSession ? <OpenAgentAction label={`Open ${name}`} onPress={() => onOpenSession(notice.sessionId)} /> : null}
        </AgentRowBody>
      }
    />
  );
}
