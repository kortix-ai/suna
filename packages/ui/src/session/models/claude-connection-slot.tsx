'use client';

import { Button } from '../../primitives/button';
import { useTranslations } from '../../i18n';
import { useModelConnectionGate } from './use-model-connection-gate';

/** The turn error kortixd writes when the session user has no Claude login (`CLAUDE_CONNECT_MESSAGE`). */
const CLAUDE_CONNECT_MESSAGE = 'Connect your Claude subscription to use Claude models.';
/** The turn error kortixd writes when Anthropic refused the stored login (`CLAUDE_RECONNECT_MESSAGE`). */
const CLAUDE_RECONNECT_MESSAGE = 'Your Claude subscription login stopped working. Reconnect Claude to continue.';

/** Which Claude fix a failed turn needs, from the error text, if any. */
export function claudeConnectionAction(text: string | null | undefined): 'connect' | 'reconnect' | null {
  const value = (text ?? '').trim();
  if (value.includes(CLAUDE_CONNECT_MESSAGE)) return 'connect';
  if (value.includes(CLAUDE_RECONNECT_MESSAGE)) return 'reconnect';
  return null;
}

/**
 * The fix for a turn that failed on the viewer's Claude login: the provider
 * list (Customize → Models → Providers), where Anthropic signs in with Claude,
 * as every other subscription does. Renders on a project route only.
 */
export function ClaudeConnectionSlot({ action, className = 'mt-2 pl-7' }: { action: 'connect' | 'reconnect'; className?: string }) {
  const t = useTranslations('claudeSubscription');
  const { canConnectProvider, openConnectProvider, modal } = useModelConnectionGate();
  if (!canConnectProvider) return null;
  return (
    <div className={className}>
      {modal}
      <Button size="sm" className="active:scale-[0.96]" onClick={() => openConnectProvider('providers')}>
        {t(action === 'reconnect' ? 'reconnectClaude' : 'connectClaude')}
      </Button>
    </div>
  );
}
