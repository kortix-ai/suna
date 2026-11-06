/**
 * Messages another agent sent this session that wait for the person's
 * approval. Port of apps/web `session/agents/held-messages.tsx`: the same
 * message card a delivered message draws, waiting on the person — who, what,
 * and Deny / Approve. Nothing renders while none waits.
 */

import { ScrollView, View } from 'react-native';
import { peerHandleLabel } from '@kortix/shared';
import { heldMessages, type PeerMessage } from '@kortix/sdk';
import { usePeerMessages } from '@kortix/sdk/react';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useToast } from '@/components/kortix/toast-provider';
import { webSpace } from '@/lib/session/user-message';
import { AgentCard } from '@/components/session/tool/shared/agent-surface';
import { SessionStatusMark } from '@/components/session/SessionStatusMark';
import { AgentPixelMark, agentSlugOfHandle } from '@/components/session/tool/shared/agent-pixel-mark';
import { FONT_MEDIUM, TURN_TYPE, useTurnPalette } from '@/components/session/tool/shared/styles';

export interface HeldMessageCardProps {
  message: PeerMessage;
  pending: 'approve' | 'deny' | null;
  onApprove: () => void;
  onDeny: () => void;
}

export function HeldMessageCard({ message, pending, onApprove, onDeny }: HeldMessageCardProps) {
  const palette = useTurnPalette();
  const from = peerHandleLabel(message.from_handle);
  const name = from.replace(/^@/, '');
  const verb = message.type === 'shutdown_request' ? 'asks this agent to stop' : 'wants to send this agent a message';
  // A decision, so a card (web `HeldMessageCard`): the face in its own column, who and what,
  // the message, and the two answers on the name's left edge.
  return (
    <AgentCard testID="held-message-card" style={{ flexDirection: 'row', gap: webSpace(1.5), padding: webSpace(3) }}>
      <View style={{ height: 20, justifyContent: 'center' }}>
        <AgentPixelMark slug={agentSlugOfHandle(message.from_handle)} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: webSpace(2.5) }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: webSpace(1.5) }}>
          <Text numberOfLines={1} style={[TURN_TYPE.sm, { flexShrink: 0, maxWidth: '45%', fontFamily: FONT_MEDIUM, color: palette.foreground }]}>
            {name}
          </Text>
          <Text numberOfLines={1} style={[TURN_TYPE.sm, { flex: 1, color: palette.mutedForeground }]}>
            {verb}
          </Text>
          <SessionStatusMark status="needs-you" />
        </View>
        {/* The whole message: a person approves only what they can read. */}
        {message.summary?.trim() ? <Text style={[TURN_TYPE.sm, { color: palette.mutedForeground }]}>{message.summary.trim()}</Text> : null}
        <ScrollView style={{ maxHeight: 240 }} nestedScrollEnabled>
          <Text selectable style={[TURN_TYPE.sm, { color: palette.foreground }]}>
            {message.message.trim()}
          </Text>
        </ScrollView>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: webSpace(2) }}>
          <Text numberOfLines={1} style={[TURN_TYPE.xs, { flex: 1, color: palette.mutedForeground }]}>
            Needs your approval · expires after 5 minutes
          </Text>
          <Button variant="secondary" size="sm" disabled={pending !== null} onPress={onDeny} accessibilityLabel={`Deny the message from ${from}`}>
            <Text>Deny</Text>
          </Button>
          <Button size="sm" disabled={pending !== null} onPress={onApprove} accessibilityLabel={`Approve the message from ${from}`}>
            <Text>Approve</Text>
          </Button>
        </View>
      </View>
    </AgentCard>
  );
}

/** The session's held messages, one card each, oldest first. */
export function HeldMessages({ projectId, sessionId }: { projectId: string | null | undefined; sessionId: string | null | undefined }) {
  const toast = useToast();
  const { data, approve, deny } = usePeerMessages(projectId, sessionId, 'in');
  const held = heldMessages(data);
  if (held.length === 0) return null;
  const pendingFor = (id: string): 'approve' | 'deny' | null =>
    approve.isPending && approve.variables === id ? 'approve' : deny.isPending && deny.variables === id ? 'deny' : null;
  const fail = (message: string) => (error: unknown) =>
    toast.error(message, { description: error instanceof Error ? error.message : undefined });
  return (
    <View testID="held-messages" accessibilityLabel="Messages waiting for you" style={{ gap: webSpace(1.5), marginTop: webSpace(4) }}>
      {held.map((message) => (
        <HeldMessageCard
          key={message.id}
          message={message}
          pending={pendingFor(message.id)}
          onApprove={() => approve.mutate(message.id, { onError: fail('Could not deliver the message') })}
          onDeny={() => deny.mutate(message.id, { onError: fail('Could not deny the message') })}
        />
      ))}
    </View>
  );
}
