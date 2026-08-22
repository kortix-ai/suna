/**
 * Plan Page — plan picker for mobile.
 *
 * Mobile has NO in-app purchase. Plans are display-only and mirror the web
 * pricing (Free / Team / Enterprise — see `lib/billing/pricing` → PRICING_PLANS,
 * synced from apps/web/src/features/billing/pricing-plans.ts). "Get Started"
 * opens the web pricing page in the system browser, where the user subscribes.
 */

import React from 'react';
import { View, Pressable, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { ArrowUpRight, Check, X } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast-provider';
import { PRICING_PLANS, type PricingPlan } from '@/lib/billing/pricing';
import { openExternalUrl } from '@/lib/billing/checkout';
import { getFrontendUrl } from '@/api/config';
import { usePricingModalStore } from '@/stores/billing-modal-store';

interface PlanPageProps {
  visible?: boolean;
  onClose?: () => void;
  onPurchaseComplete?: () => void;
}

export function PlanPage({ visible = true, onClose }: PlanPageProps) {
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const { alertTitle, alertSubtitle } = usePricingModalStore();

  const openPricing = React.useCallback(async () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await openExternalUrl(`${getFrontendUrl()}/pricing`);
    } catch {
      toast.error('Could not open the pricing page. Please try again.');
    }
  }, [toast]);

  const continueFree = React.useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose?.();
  }, [onClose]);

  if (!visible) return null;

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View
        className="flex-row items-center justify-between border-b border-border/30 px-5"
        style={{ paddingTop: insets.top + 10, paddingBottom: 12 }}>
        <Text variant="large">Plans</Text>
        {onClose ? (
          <Pressable
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              onClose();
            }}
            hitSlop={10}
            className="-mr-1 h-9 w-9 items-center justify-center">
            <Icon as={X} size={20} className="text-muted-foreground" />
          </Pressable>
        ) : (
          <View className="h-9 w-9" />
        )}
      </View>

      <ScrollView
        className="flex-1"
        contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 24, gap: 14 }}
        showsVerticalScrollIndicator={false}>
        {alertTitle ? (
          <View className="rounded-xl border border-border bg-secondary/60 p-4">
            <Text className="font-semibold">{alertTitle}</Text>
            {alertSubtitle ? (
              <Text variant="muted" className="mt-1">
                {alertSubtitle}
              </Text>
            ) : null}
          </View>
        ) : null}

        <Text variant="muted" className="text-center">
          Choose a plan — subscriptions are managed securely on the web.
        </Text>

        {PRICING_PLANS.map((plan, i) => (
          <PlanCard
            key={plan.id}
            plan={plan}
            index={i}
            onGetStarted={openPricing}
            onContinueFree={continueFree}
          />
        ))}

        <Text variant="muted" className="mt-1 text-center text-xs">
          Prices in USD. You'll finish checkout on kortix.com.
        </Text>
      </ScrollView>
    </View>
  );
}

function PlanCard({
  plan,
  index,
  onGetStarted,
  onContinueFree,
}: {
  plan: PricingPlan;
  index: number;
  onGetStarted: () => void;
  onContinueFree: () => void;
}) {
  const isFree = plan.id === 'free';
  const ctaLabel = plan.id === 'enterprise' ? 'Contact sales' : 'Get Started';

  return (
    <Animated.View
      entering={FadeInDown.delay(index * 60).duration(400)}
      className={`rounded-2xl border bg-secondary/50 p-5 ${
        plan.highlight ? 'border-kortix-blue' : 'border-border'
      }`}>
      <View className="flex-row items-center gap-2">
        {plan.icon ? <Icon as={plan.icon} size={18} className="text-foreground" /> : null}
        <Text className="font-semibold text-lg">{plan.name}</Text>
        {plan.badge ? (
          <View className="ml-1 rounded-full bg-kortix-blue px-2 py-0.5">
            <Text className="text-[11px] font-medium text-white">{plan.badge}</Text>
          </View>
        ) : null}
      </View>

      <View className="mt-2 flex-row items-baseline gap-1">
        <Text className="font-bold text-3xl">{plan.price}</Text>
        {plan.unit ? <Text variant="muted">{plan.unit}</Text> : null}
      </View>
      <Text variant="muted" className="mt-1">
        {plan.note}
      </Text>

      <View className="mt-4 gap-2">
        {plan.features.map((f) => (
          <View key={f} className="flex-row items-start gap-2">
            <Icon as={Check} size={16} className="mt-0.5 text-kortix-green" strokeWidth={2.4} />
            <Text variant="small" className="flex-1 text-foreground">
              {f}
            </Text>
          </View>
        ))}
      </View>

      {isFree ? (
        <Button
          variant="secondary"
          size="lg"
          className="mt-5 h-12 w-full"
          onPress={onContinueFree}>
          <Text>Continue on Free</Text>
        </Button>
      ) : (
        <Button
          variant={plan.highlight ? 'default' : 'secondary'}
          size="lg"
          className="mt-5 h-12 w-full"
          onPress={onGetStarted}>
          <Text>{ctaLabel}</Text>
          <Icon
            as={ArrowUpRight}
            size={17}
            className={plan.highlight ? 'text-primary-foreground' : 'text-foreground'}
            strokeWidth={2.2}
          />
        </Button>
      )}
    </Animated.View>
  );
}
