'use client';

import { CreditCard, KeyRound } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/features/layout/section/empty-state';
import { useModelConnectionGate } from './use-model-connection-gate';

/**
 * The single "no model connected" teaching moment — an icon, a plain-English
 * explanation, and the two ways out: upgrade to a Kortix plan, or bring an API
 * key from any provider. Shared by the chat input's full-block gate and the
 * project onboarding wizard so the copy and actions never drift apart.
 */
export function ModelConnectionGate({
  size = 'default',
  className,
}: {
  size?: 'sm' | 'default';
  className?: string;
}) {
  const { openConnectProvider, openUpgrade, modal } = useModelConnectionGate();

  return (
    <>
      {modal}
      <EmptyState
        className={className}
        icon={KeyRound}
        size={size}
        title="Connect a model to start chatting"
        description="This session needs an LLM connected before it can respond. Upgrade for instant access to Kortix's managed models, or bring your own API key from any provider."
        action={
          <Button type="button" size="sm" onClick={openUpgrade}>
            <CreditCard className="size-3.5" />
            Upgrade
          </Button>
        }
        secondaryAction={
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => openConnectProvider('providers')}
          >
            <KeyRound className="size-3.5" />
            Bring your own key
          </Button>
        }
      />
    </>
  );
}
