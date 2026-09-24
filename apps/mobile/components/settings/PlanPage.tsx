/**
 * Plans — `/plans`, where a user picks a plan and upgrades. Opened from
 * Billing → Change plan and from the upgrade sheet.
 *
 * Mobile has no in-app purchase. The button opens kortix.com — web billing,
 * or the contact page for Enterprise — where checkout happens. Plans mirror
 * the web pricing (`lib/billing/pricing` → PRICING_PLANS); which plan is
 * current and what the button does come from `lib/billing/plan-action`.
 *
 * Layout (apps/mobile/design.md): a Plan picker (icon · name · price, or
 * "Current" · check), the seat total for Team, the selected plan's features,
 * and one pill pinned above the home indicator.
 */

import * as React from 'react';
import { AppState, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowUpRightIcon as ArrowUpRight, CheckIcon as Check, UsersIcon as Users } from '@/lib/icons';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import {
  SettingsGroup,
  SettingsHeader,
  SettingsPage,
  SettingsRow,
} from '@/components/kortix/settings-list';
import { useToast } from '@/components/kortix/toast-provider';
import { useLanguage } from '@/contexts';
import { useActiveAccount } from '@/hooks/useActiveAccount';
import { useAccountState } from '@/lib/billing/hooks';
import { openExternalUrl } from '@/lib/billing/checkout';
import {
  defaultPlanSelection,
  getPlanAction,
  getPlanFamily,
  isCurrentPlan,
  type PlanAction,
} from '@/lib/billing/plan-action';
import { PRICING_PLANS, type PricingPlan, type PricingPlanId } from '@/lib/billing/pricing';
import { getTeamUpgradeOffer } from '@/lib/billing/team-upgrade-offer';
import { getWebBillingUrl, getWebContactSalesUrl } from '@/lib/billing/web-links';
import { haptics } from '@/lib/haptics';

interface PlanPageProps {
  visible?: boolean;
  /** Kept for API compatibility; the header's back button navigates via the router. */
  onClose?: () => void;
  onPurchaseComplete?: () => void;
}

export function PlanPage({ visible = true }: PlanPageProps) {
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const { account, isLoading: isLoadingAccount } = useActiveAccount();
  const { data: accountState, refetch } = useAccountState({
    accountId: account?.account_id ?? undefined,
    enabled: visible && !isLoadingAccount,
  });

  // Back from kortix.com after a checkout: the current plan moves.
  React.useEffect(() => {
    if (!visible) return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refetch();
    });
    return () => subscription.remove();
  }, [visible, refetch]);

  const current = getPlanFamily(accountState);
  const offer = getTeamUpgradeOffer(accountState);
  // Until the user taps a plan, the selection follows the loaded account.
  const [picked, setPicked] = React.useState<PricingPlanId | null>(null);
  const selected = picked ?? defaultPlanSelection(current);
  const plan = PRICING_PLANS.find((p) => p.id === selected) ?? PRICING_PLANS[0];
  const action = getPlanAction({ selected, current, canManageBilling: offer.canManageBilling });

  if (!visible) return null;

  const priceOf = (p: PricingPlan) => {
    // "Current" only once the account state is loaded, so Free is never
    // briefly marked current for a paying account.
    if (accountState && isCurrentPlan(p.id, current)) return t('plans.current', 'Current');
    return p.id === 'team' ? `$${offer.pricePerSeat} / seat` : p.price;
  };

  const runAction = async () => {
    const url = action === 'contact-sales' ? getWebContactSalesUrl() : getWebBillingUrl();
    haptics.medium();
    try {
      await openExternalUrl(url);
    } catch {
      toast.error(t('billing.openWebFailed', 'Could not open kortix.com. Try again.'));
    }
  };

  return (
    <View className="flex-1 bg-background">
      <SettingsHeader title={t('plans.title', 'Plans')} />
      <SettingsPage paddingBottom={24}>
        <SettingsGroup title={t('plans.plan', 'Plan')}>
          {PRICING_PLANS.map((p) => (
            <SettingsRow
              key={p.id}
              icon={p.icon}
              label={p.name}
              value={priceOf(p)}
              checked={p.id === selected}
              right={null}
              onPress={() => {
                haptics.selection();
                setPicked(p.id);
              }}
            />
          ))}
        </SettingsGroup>

        {selected === 'team' && offer.hasSeatMath ? (
          <SettingsGroup>
            <SettingsRow
              icon={Users}
              label={t('plans.seats', {
                defaultValue: '{{count}} seats × ${{price}}',
                count: offer.seatCount,
                price: offer.pricePerSeat,
              })}
              value={t('plans.perMonth', { defaultValue: '${{total}} / mo', total: offer.monthlyTotal })}
            />
          </SettingsGroup>
        ) : null}

        <SettingsGroup title={t('plans.includes', { defaultValue: '{{plan}} includes', plan: plan.name })}>
          {plan.features.map((feature) => (
            <SettingsRow key={feature} icon={Check} label={feature} multiline />
          ))}
        </SettingsGroup>
      </SettingsPage>

      <View className="bg-background px-4 pt-3" style={{ paddingBottom: Math.max(insets.bottom, 16) }}>
        <PlanActionButton action={action} planName={plan.name} onPress={runAction} />
      </View>
    </View>
  );
}

function PlanActionButton({
  action,
  planName,
  onPress,
}: {
  action: PlanAction;
  planName: string;
  onPress: () => void;
}) {
  const { t } = useLanguage();

  const label = {
    current: t('plans.currentPlan', 'Current plan'),
    'ask-owner': t('plans.askOwner', 'Ask an account owner to upgrade'),
    'contact-sales': t('plans.contactSales', 'Contact sales'),
    upgrade: t('plans.upgradeTo', { defaultValue: 'Upgrade to {{plan}}', plan: planName }),
    switch: t('plans.switchTo', { defaultValue: 'Switch to {{plan}}', plan: planName }),
  }[action];
  const opensWeb = action === 'contact-sales' || action === 'upgrade' || action === 'switch';

  return (
    <Button size="lg" className="rounded-full" disabled={!opensWeb} onPress={onPress}>
      <Text>{label}</Text>
      {opensWeb ? <Icon as={ArrowUpRight} size={18} /> : null}
    </Button>
  );
}
