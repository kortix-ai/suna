'use client';

import { AutoTopupCard } from '@/features/billing/auto-topup-card';
import { CreditTopupSection } from '@/features/billing/credit-topup-section';
import { type AccountState, canOfferTopup } from '@kortix/sdk';
import type { ReactNode } from 'react';

/**
 * Add credits and Auto top-up in one card: the one place a purchase control
 * renders (KRTX-1720). The settings Credits pane, the account Billing tab and
 * the out-of-credits modal all render this.
 *
 * It renders the controls only when `canOfferTopup(state)` holds: the plan may
 * buy credits and the viewer may change billing. A member, and anyone whose
 * account state is still loading, gets `fallback` instead: the purchase routes
 * answer a member 403. `billing-source-rules.test.ts` fails when either control
 * renders anywhere else.
 *
 * `CreditTopupSection` renders no chrome of its own and `AutoTopupCard`
 * carries its own heading, so the seam is a plain `border-t` and only the
 * first half takes a `heading` from the caller.
 */
export function TopupControls({
  state,
  heading,
  fallback = null,
}: {
  state: AccountState | null | undefined;
  heading?: ReactNode;
  fallback?: ReactNode;
}) {
  if (!canOfferTopup(state)) return <>{fallback}</>;
  return (
    <div className="bg-popover rounded-md border">
      <section className="space-y-3 px-4 py-4">
        {heading ? <h3 className="text-foreground text-sm font-medium">{heading}</h3> : null}
        <CreditTopupSection />
      </section>
      <div className="border-t px-4 py-4">
        <AutoTopupCard fetchSettings showSaveButton />
      </div>
    </div>
  );
}
