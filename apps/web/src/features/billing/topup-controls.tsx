'use client';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@kortix/ui/collapsible';
import { AutoTopupCard } from '@/features/billing/auto-topup-card';
import { formatWholeUsd } from '@kortix/ui/internal/billing/compute-pricing';
import { CreditTopupSection } from '@/features/billing/credit-topup-section';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { type AccountState, canOfferTopup } from '@kortix/sdk';
import { formatUsdAsCredits } from '@kortix/shared';
import { CaretRightIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

/**
 * Add credits, with Auto top-up folded underneath: the one place a purchase
 * control renders (KRTX-1720). The settings Credits pane, the account Billing
 * tab and the out-of-credits modal all render this.
 *
 * It renders the controls only when `canOfferTopup(state)` holds: the plan may
 * buy credits and the viewer may change billing. A member, and anyone whose
 * account state is still loading, gets `fallback` instead: the purchase routes
 * answer a member 403. `billing-source-rules.test.ts` fails when either control
 * renders anywhere else.
 *
 * Auto top-up is a set-once setting, so it sits behind one status line and
 * opens on demand; the one-time purchase stays the visible action.
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
  const t = useTranslations('billing.topup');
  const locale = useLocale();
  if (!canOfferTopup(state)) return <>{fallback}</>;
  const auto = state?.auto_topup;
  const status = auto?.enabled
    ? t('autoTopupOn', {
        amount: formatWholeUsd(auto.amount, locale),
        // The threshold is an amount the account holds: credits. The amount
        // is a purchase: dollars.
        threshold: formatUsdAsCredits(auto.threshold, { locale }),
      })
    : t('autoTopupOff');
  return (
    <div className="bg-popover rounded-md border">
      <section className="space-y-3 px-4 py-4">
        {heading ? <h3 className="text-foreground text-sm font-medium">{heading}</h3> : null}
        <CreditTopupSection />
      </section>
      <Collapsible className="group/auto border-t">
        <CollapsibleTrigger className="text-muted-foreground hover:text-foreground focus-visible:ring-kortix-base flex w-full cursor-pointer items-center gap-1.5 px-4 py-3 text-left text-xs transition-colors outline-none focus-visible:ring-[0.6px]">
          <CaretRightIcon
            aria-hidden
            className="size-3 shrink-0 transition-transform group-data-[state=open]/auto:rotate-90"
          />
          <span className="truncate">{status}</span>
        </CollapsibleTrigger>
        <CollapsibleContent className="px-4 pb-4">
          <AutoTopupCard fetchSettings showSaveButton />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
