'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { useTranslations } from '@/i18n/use-translations';
import { requestTopUp } from '@kortix/sdk';

/**
 * KRTX-1718: the member's way to tell an owner, from where they are blocked.
 * Emails every owner; the API takes one request per member a day (429 after).
 */
export function AskOwnerForCreditsButton({ accountId }: { accountId: string }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [state, setState] = useState<'idle' | 'asking' | 'asked' | 'already' | 'failed'>('idle');
  const label =
    state === 'asked'
      ? 'ownersNotified'
      : state === 'already'
        ? 'alreadyAskedToday'
        : state === 'failed'
          ? 'askOwnerFailed'
          : 'askOwnerForCredits';
  const ask = async () => {
    setState('asking');
    try {
      await requestTopUp(accountId);
      setState('asked');
    } catch (err) {
      setState((err as { status?: number })?.status === 429 ? 'already' : 'failed');
    }
  };
  return (
    <Button
      variant="outline"
      size="sm"
      className="active:scale-[0.96]"
      disabled={state === 'asking' || state === 'asked' || state === 'already'}
      onClick={() => void ask()}
    >
      {state === 'asking' ? <Loading className="size-3.5 shrink-0" /> : null}
      {tHardcodedUi.raw(`componentsSessionSessionErrorBanner.${label}`)}
    </Button>
  );
}
