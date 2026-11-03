'use client';

import { Button } from '../../primitives/button';
import { SessionDotMatrix } from '../../primitives/dot-matrix/session-dot-matrix';
import { errorToast } from '../../primitives/toast';
import { useTranslations } from '../../i18n';
import { cn } from '../../lib/utils';
import { AgentMarkGlyph, agentMarkTileClass, agentMarkVars } from '../../internal/components/agent-mark';
import { AgentCard } from './agent-surface';
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
  const handle = message.from_handle;
  const slug = /^(mykortix|meta)-[0-9a-f]{8}$/.test(handle) ? 'mykortix' : handle;
  // The same message card a delivered message draws, waiting on the person: who, what, and the two answers.
  return (
    <div data-held-message={message.id}>
    <AgentCard testId="held-message-card">
      <div className="flex min-w-0 items-center gap-2.5 px-3.5 py-2.5">
        <span
          aria-hidden
          style={agentMarkVars(slug)}
          className={cn('flex size-5 shrink-0 items-center justify-center rounded-sm bg-(--mark-tile)', agentMarkTileClass(slug))}
        >
          <AgentMarkGlyph slug={slug} size={14} />
        </span>
        <span className="text-foreground min-w-0 truncate font-medium">{t(kind, { from: peerHandleLabel(handle) })}</span>
        <span className="flex-1" />
        <span className="text-kortix-blue shrink-0 text-xs">{t('waitingShort')}</span>
      </div>
      <div className="border-border flex flex-col gap-2.5 border-t px-3.5 py-2.5">
        <p className="text-foreground line-clamp-3 wrap-break-word">{heldPreview(message)}</p>
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">{t('expires')}</span>
          <Button type="button" size="xs" variant="secondary" disabled={pending !== null} onClick={onDeny}>
            {pending === 'deny' ? <SessionDotMatrix size={14} className="shrink-0" /> : null}
            {t('deny')}
          </Button>
          <Button type="button" size="xs" disabled={pending !== null} onClick={onApprove}>
            {pending === 'approve' ? <SessionDotMatrix size={14} className="shrink-0" /> : null}
            {t('approve')}
          </Button>
        </div>
      </div>
    </AgentCard>
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
