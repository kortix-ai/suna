/**
 * Messages another agent sent this session that wait for the person's
 * approval. Port of apps/web `session/agents/held-messages.tsx`: the same
 * message card a delivered message draws, waiting on the person — who, what,
 * and Deny / Approve. Nothing renders while none waits.
 */

import { View } from 'react-native';
import { peerHandleLabel } from '@kortix/shared';
import type { PeerMessage } from '@kortix/sdk';
import { usePeerMessages } from '@kortix/sdk/react';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { useToast } from '@/components/kortix/toast-provider';
import { heldMessages, heldPreview } from '@/lib/session/multi-agent';
import { webSpace } from '@/lib/session/user-message';
import { AgentCard } from '@/components/session/tool/shared/agent-surface';
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
  const title = message.type === 'shutdown_request' ? `${from} asks this session to stop` : `Message from ${from}`;
  return (
    <AgentCard testID="held-message-card">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: webSpace(2.5), paddingHorizontal: webSpace(3.5), minHeight: 44 }}>
        <AgentPixelMark slug={agentSlugOfHandle(message.from_handle)} />
        <Text numberOfLines={1} style={[TURN_TYPE.sm, { flex: 1, fontFamily: FONT_MEDIUM, color: palette.foreground }]}>
          {title}
        </Text>
        <Text style={[TURN_TYPE.xs, { color: palette.info }]}>Waiting for your approval</Text>
      </View>
      <View style={{ borderTopWidth: 1, borderTopColor: palette.border, paddingHorizontal: webSpace(3.5), paddingVertical: webSpace(2.5), gap: webSpace(2.5) }}>
        <Text numberOfLines={3} style={[TURN_TYPE.sm, { color: palette.foreground }]}>
          {heldPreview(message)}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: webSpace(1.5) }}>
          <Text numberOfLines={1} style={[TURN_TYPE.xs, { flex: 1, color: palette.mutedForeground }]}>
            Expires after 5 minutes
          </Text>
          <Button variant="secondary" disabled={pending !== null} onPress={onDeny} accessibilityLabel={`Deny the message from ${from}`}>
            {pending === 'deny' ? <KortixLoader customSize={14} /> : null}
            <Text>Deny</Text>
          </Button>
          <Button disabled={pending !== null} onPress={onApprove} accessibilityLabel={`Approve the message from ${from}`}>
            {pending === 'approve' ? <KortixLoader customSize={14} /> : null}
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
