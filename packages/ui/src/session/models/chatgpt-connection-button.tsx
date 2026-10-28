'use client';

import { useTranslations } from '../../i18n';
import { Button } from '../../primitives/button';
import { cn } from '../../lib/utils';
import { useSessionIds } from '../../providers/session-ids';
import { useUiComponents, useUiViewerId } from '../../providers/ui-provider';
import {
  useFeatureFlag,
  useModelAccess,
  useProjectSession,
  useSessionProviderSecretPools,
} from '@kortix/sdk/react';
import { useState } from 'react';
import { type ChatGptConnectionAction, chatGptActionApplies } from './chatgpt-connection-action';
import { sessionPersonalUser } from '../overrides/provider-pool-draft';

/**
 * The ChatGPT fix for a failed turn or tool call (the session error row, the
 * image card). It needs the session the call belongs to, so it renders only on
 * a session route; elsewhere the row stays informational.
 */
export function ChatGptConnectionSlot({
  action,
  className = 'mt-2 pl-7',
}: {
  action: ChatGptConnectionAction;
  /** The wrapper's placement in the host row. */
  className?: string;
}) {
  const ids = useSessionIds();
  const projectId = ids.projectId ?? null;
  const sessionId = ids.sessionId ?? null;
  if (!projectId || !sessionId) return null;
  return <ChatGptConnectionButton action={action} projectId={projectId} sessionId={sessionId} className={className} />;
}

/**
 * Opens the ChatGPT accounts dialog, which exists only with pooled provider
 * secrets and the LLM gateway on. Shown only where connecting or
 * reconnecting an account can fix this session (`chatGptActionApplies`).
 */
function ChatGptConnectionButton({
  action,
  projectId,
  sessionId,
  className,
}: {
  action: ChatGptConnectionAction;
  projectId: string;
  sessionId: string;
  className: string;
}) {
  const t = useTranslations('pooledSecrets');
  const viewerId = useUiViewerId();
  const pooled = useFeatureFlag(projectId, 'pooled_provider_secrets');
  const enabled = pooled.enabled;
  const access = useModelAccess(enabled ? projectId : null);
  const session = useProjectSession(projectId, sessionId, { enabled });
  const pools = useSessionProviderSecretPools(enabled ? projectId : null, sessionId);
  const [open, setOpen] = useState(false);
  const { ProviderAccountsModal } = useUiComponents();

  const applies =
    !!ProviderAccountsModal &&
    enabled &&
    !(access.data?.disabledProviders ?? []).includes('codex') &&
    chatGptActionApplies({
      action,
      personalUser: sessionPersonalUser(session.data),
      viewerId: viewerId,
      explicitSelection: pools.isSuccess
        ? pools.data.pools.some((pool) => pool.provider_id === 'codex')
        : undefined,
    });
  if (!applies || !ProviderAccountsModal) return null;

  return (
    <div className={cn(className)}>
      <Button size="sm" className="active:scale-[0.96]" onClick={() => setOpen(true)}>
        {t(action === 'reconnect' ? 'reconnectChatGpt' : 'connectChatGpt')}
      </Button>
      <ProviderAccountsModal projectId={projectId} providerId="codex" open={open} onOpenChange={setOpen} />
    </div>
  );
}
