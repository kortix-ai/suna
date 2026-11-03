/**
 * A finish notice in place of the user bubble: nobody typed this turn. Port of
 * apps/web `session/turn/subagent-notice-row.tsx` + `notice-batch-group.tsx`
 * (Paper F2–F5):
 *
 *   ─────  ✓ Kortix growth marketing deep dive finished · View run  ─────
 *   ┌ Result · Completed the full strategy and executive summary   ⌄ ┐
 *   └ (tap: the report, as markdown, inside the card)                ┘
 *
 * A batch is one line ("3 agents finished") and one card listing each agent
 * (mark · name · first line), each opening its session.
 */

import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { peerHandleLabel } from '@kortix/shared';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { SessionStatusMark } from '@/components/session/SessionStatusMark';
import { CaretDownIcon, FileTextIcon } from '@/lib/icons';
import {
  NOTICE_GLYPH,
  batchTitle,
  noticeExcerpt,
  noticeHeadline,
  noticeReport,
  type AgentNoticePrompt,
} from '@/lib/session/agent-notice';
import { peerMessagePreview } from '@/lib/session/multi-agent';
import { webSpace } from '@/lib/session/user-message';
import { AgentCard, FinishLine } from '@/components/session/tool/shared/agent-surface';
import { OutputBlock } from '@/components/session/tool/shared/output-block';
import { FONT_MEDIUM, TURN_TYPE, useTurnPalette } from '@/components/session/tool/shared/styles';
import type { SubagentNotice } from '@kortix/sdk';

export function AgentNotice({ prompt, onOpenSession }: { prompt: AgentNoticePrompt; onOpenSession?: (sessionId: string) => void }) {
  return (
    <View testID="agent-notice" className="px-4" style={{ gap: webSpace(3.5) }}>
      {prompt.kind === 'single' ? (
        <SingleNotice notice={prompt.notice} onOpenSession={onOpenSession} />
      ) : (
        <BatchNotice prompt={prompt} onOpenSession={onOpenSession} />
      )}
    </View>
  );
}

function ViewAction({ onPress, label = 'View run' }: { onPress: () => void; label?: string }) {
  const palette = useTurnPalette();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} hitSlop={webSpace(3)}>
      <Text style={[TURN_TYPE.xs, { color: palette.foreground, textDecorationLine: 'underline' }]}>{label}</Text>
    </Pressable>
  );
}

function SingleNotice({ notice, onOpenSession }: { notice: SubagentNotice; onOpenSession?: (sessionId: string) => void }) {
  const palette = useTurnPalette();
  const [open, setOpen] = useState(false);
  const report = noticeReport(notice.result);
  const excerpt = noticeExcerpt(report);
  const failed = notice.status === 'failed';
  return (
    <>
      <FinishLine mark={<SessionStatusMark status={NOTICE_GLYPH[notice.status]} />}>
        <Text numberOfLines={1} style={[TURN_TYPE.xs, { flexShrink: 1, color: failed ? palette.destructive : palette.foreground }]}>
          {noticeHeadline(notice)}
        </Text>
        {onOpenSession ? (
          <>
            <Text style={[TURN_TYPE.xs, { color: palette.mutedForeground }]}>·</Text>
            <ViewAction onPress={() => onOpenSession(notice.sessionId)} />
          </>
        ) : null}
      </FinishLine>
      {report ? (
        <AgentCard testID="notice-result">
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            accessibilityLabel={`Result${excerpt ? `, ${excerpt}` : ''}`}
            onPress={() => setOpen((value) => !value)}
            style={({ pressed }) => [
              { flexDirection: 'row', alignItems: 'center', gap: webSpace(3), paddingHorizontal: webSpace(3.5), minHeight: 44 },
              pressed && { backgroundColor: palette.pressed },
            ]}
          >
            <Icon as={FileTextIcon} size={16} className="text-muted-foreground" />
            <Text style={[TURN_TYPE.sm, { fontFamily: FONT_MEDIUM, color: palette.foreground }]}>Result</Text>
            <Text numberOfLines={1} style={[TURN_TYPE.sm, { flex: 1, color: palette.mutedForeground }]}>
              {excerpt ?? ''}
            </Text>
            <View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}>
              <Icon as={CaretDownIcon} size={14} className="text-muted-foreground" />
            </View>
          </Pressable>
          {open ? (
            <View style={{ borderTopWidth: 1, borderTopColor: palette.border, padding: webSpace(3) }}>
              <OutputBlock text={report} markdown />
            </View>
          ) : null}
        </AgentCard>
      ) : null}
    </>
  );
}

function BatchNotice({
  prompt,
  onOpenSession,
}: {
  prompt: Extract<AgentNoticePrompt, { kind: 'batch' }>;
  onOpenSession?: (sessionId: string) => void;
}) {
  const palette = useTurnPalette();
  const anyFailed = prompt.items.some((item) => item.kind !== 'peer_idle' && item.notice.status === 'failed');
  return (
    <>
      <FinishLine mark={<SessionStatusMark status={anyFailed ? 'failed' : 'done'} />}>
        <Text style={[TURN_TYPE.xs, { color: palette.foreground }]}>{batchTitle(prompt.items.length)}</Text>
      </FinishLine>
      <AgentCard testID="notice-batch">
        {prompt.items.map((item, index) => {
          const isPeer = item.kind === 'peer_idle';
          const name = isPeer ? `${peerHandleLabel(item.info.from)} finished` : noticeHeadline(item.notice);
          const line = isPeer ? peerMessagePreview({ ...item.info, kind: 'idle_notice' }) || null : noticeExcerpt(noticeReport(item.notice.result));
          const sessionId = isPeer ? null : item.notice.sessionId;
          const glyph = isPeer ? 'done' : NOTICE_GLYPH[item.notice.status];
          const rowStyle = {
            flexDirection: 'row' as const,
            alignItems: 'center' as const,
            gap: webSpace(2.5),
            paddingHorizontal: webSpace(3.5),
            minHeight: 44,
            borderTopWidth: index > 0 ? 1 : 0,
            borderTopColor: palette.border,
          };
          const body = (
            <>
              <SessionStatusMark status={glyph} />
              <Text numberOfLines={1} style={[TURN_TYPE.sm, { flexShrink: 0, maxWidth: '55%', fontFamily: FONT_MEDIUM, color: palette.foreground }]}>
                {name}
              </Text>
              <Text numberOfLines={1} style={[TURN_TYPE.xs, { flex: 1, color: palette.mutedForeground }]}>
                {line ?? ''}
              </Text>
            </>
          );
          const key = isPeer ? `peer-${item.info.messageId}` : `${item.notice.sessionId}-${index}`;
          return sessionId && onOpenSession ? (
            <Pressable
              key={key}
              accessibilityRole="button"
              accessibilityLabel={`Open ${name}`}
              onPress={() => onOpenSession(sessionId)}
              style={({ pressed }) => [rowStyle, pressed && { backgroundColor: palette.pressed }]}
            >
              {body}
            </Pressable>
          ) : (
            <View key={key} style={rowStyle}>
              {body}
            </View>
          );
        })}
      </AgentCard>
    </>
  );
}
