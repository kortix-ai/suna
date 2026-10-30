'use client';

import { Button } from '../../primitives/button';
import { SessionDotMatrix } from '../../primitives/dot-matrix/session-dot-matrix';
import { errorToast } from '../../primitives/toast';
import { useTranslations } from '../../i18n';
import { ChatCircleDotsIcon } from '@phosphor-icons/react';
import { peerHandleLabel } from '@kortix/shared';
import type { PeerMessage } from '@kortix/sdk';
import { usePeerMessages } from '@kortix/sdk/react';

/**
 * Messages from other sessions that wait for the person (`inbound: hold`, or a
 * session the person asked to approve first). Claude Code opens an approval
 * dialog with the sender and a preview; Kortix shows one card per message above
 * the agent strip. "Approve message" delivers it, "Deny" drops it. A message
 * nobody decides expires after 5 minutes on the server.
 */

/** The preview line: the sender's summary, else the message's first line. */
export function heldPreview(message: Pick<PeerMessage, 'summary' | 'message'>): string {
  const summary = message.summary?.trim();
  if (summary) return summary;
  const first = message.message.trim().split('\n')[0] ?? '';
  return first.length > 200 ? `${first.slice(0, 200)}…` : first;
}

export interface HeldMessageCardProps {
  message: PeerMessage;
  pending: 'approve' | 'deny' | null;
  onApprove: () => void;
  onDeny: () => void;
}

export function HeldMessageCard({ message, pending, onApprove, onDeny }: HeldMessageCardProps) {
  const t = useTranslations('multiAgent.held');
  const kind = message.type === 'shutdown_request' ? 'titleShutdown' : 'title';
  return (
    <div
      data-held-message={message.id}
      className="bg-popover flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-xs"
    >
      <ChatCircleDotsIcon aria-hidden className="text-muted-foreground mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-foreground text-sm font-medium">{t(kind, { from: peerHandleLabel(message.from_handle) })}</p>
        <p className="text-foreground line-clamp-2 wrap-break-word">{heldPreview(message)}</p>
        <p className="text-muted-foreground">{t('waiting')}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button type="button" size="xs" variant="outline-ghost" disabled={pending !== null} onClick={onDeny}>
          {pending === 'deny' ? <SessionDotMatrix size={14} className="shrink-0" /> : null}
          {t('deny')}
        </Button>
        <Button type="button" size="xs" disabled={pending !== null} onClick={onApprove}>
          {pending === 'approve' ? <SessionDotMatrix size={14} className="shrink-0" /> : null}
          {t('approve')}
        </Button>
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

/** The messages that wait for the person, oldest first (the order they arrived). */
export function heldMessages(messages: readonly PeerMessage[] | undefined): PeerMessage[] {
  return (messages ?? [])
    .filter((message) => message.status === 'held')
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}

/** A session's held messages, read on their own (for a host without the agent strip). */
export function HeldMessages({ projectId, sessionId }: { projectId: string | undefined; sessionId: string | undefined }) {
  const { data, approve, deny } = usePeerMessages(projectId, sessionId, 'in');
  return <HeldMessageList messages={data} approve={approve} deny={deny} />;
}
