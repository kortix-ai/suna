'use client';

import { Button } from '../../primitives/button';
import { errorToast } from '../../primitives/toast';
import { useTranslations } from '../../i18n';
import { AgentFace, AgentStatus } from './agent-surface';
import { peerHandleLabel } from '@kortix/shared';
import { heldMessages, type PeerMessage } from '@kortix/sdk';
import { usePeerMessages } from '@kortix/sdk/react';

/**
 * Messages from other sessions that wait for the person (`inbound: hold`, or a
 * session the person asked to approve first). Claude Code opens an approval
 * dialog with the sender and a preview; Kortix shows one card per message above
 * the agent strip. "Approve message" delivers it, "Deny" drops it. A message
 * nobody decides expires after 5 minutes on the server.
 */

export interface HeldMessageCardProps {
  message: PeerMessage;
  pending: 'approve' | 'deny' | null;
  onApprove: () => void;
  onDeny: () => void;
}

export function HeldMessageCard({ message, pending, onApprove, onDeny }: HeldMessageCardProps) {
  const t = useTranslations('multiAgent.held');
  const handle = message.from_handle;
  const name = peerHandleLabel(handle).replace(/^@/, '');
  const shutdown = message.type === 'shutdown_request';
  // A decision, so a card: who, what it would deliver, and the two answers. The rest of the
  // agent surfaces are rows; this one waits on the person.
  return (
    <div
      data-held-message={message.id}
      data-testid="held-message-card"
      className="border-border bg-background flex min-w-0 gap-1.5 rounded-lg border p-3 text-sm"
    >
      <span className="flex h-5 shrink-0 items-center">
        <AgentFace handle={handle} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
          <span className="text-foreground max-w-40 min-w-0 truncate font-medium" title={name}>
            {name}
          </span>
          <span className="text-muted-foreground min-w-0 flex-1">{shutdown ? t('asksStop') : t('wantsToSend')}</span>
          <AgentStatus status="needs-you" label={t('needsApproval')} />
        </div>
        {/* The whole message: a person approves only what they can read. */}
        {message.summary?.trim() && <p className="text-muted-foreground">{message.summary.trim()}</p>}
        <p data-slot="held-message-body" className="text-foreground max-h-60 overflow-y-auto whitespace-pre-wrap wrap-anywhere">
          {message.message.trim()}
        </p>
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">{t('expires')}</span>
          <Button type="button" size="xs" variant="secondary" disabled={pending !== null} aria-busy={pending === 'deny'} onClick={onDeny}>
            {t('deny')}
          </Button>
          <Button type="button" size="xs" disabled={pending !== null} aria-busy={pending === 'approve'} onClick={onApprove}>
            {t('approve')}
          </Button>
        </div>
      </div>
    </div>
  );
}

type PeerMessagesQuery = ReturnType<typeof usePeerMessages>;

/** The held messages of `usePeerMessages(…, 'in')`, one card each; nothing when none waits. */
export function HeldMessageList({
  messages,
  approve,
  deny,
}: {
  messages: readonly PeerMessage[] | undefined;
  approve: PeerMessagesQuery['approve'];
  deny: PeerMessagesQuery['deny'];
}) {
  const t = useTranslations('multiAgent.held');
  const held = heldMessages(messages);
  if (held.length === 0) return null;
  const pendingFor = (id: string): 'approve' | 'deny' | null =>
    approve.isPending && approve.variables === id ? 'approve' : deny.isPending && deny.variables === id ? 'deny' : null;
  const fail = (key: 'approveFailed' | 'denyFailed') => (error: unknown) =>
    errorToast(t(key), { description: error instanceof Error ? error.message : undefined });
  return (
    <div aria-label={t('label')} role="group" className="space-y-1.5">
      {held.map((message) => (
        <HeldMessageCard
          key={message.id}
          message={message}
          pending={pendingFor(message.id)}
          onApprove={() => approve.mutate(message.id, { onError: fail('approveFailed') })}
          onDeny={() => deny.mutate(message.id, { onError: fail('denyFailed') })}
        />
      ))}
    </div>
  );
}

/** A session's held messages, read on their own (for a host without the agent strip). */
export function HeldMessages({ projectId, sessionId }: { projectId: string | undefined; sessionId: string | undefined }) {
  const { data, approve, deny } = usePeerMessages(projectId, sessionId, 'in');
  return <HeldMessageList messages={data} approve={approve} deny={deny} />;
}
