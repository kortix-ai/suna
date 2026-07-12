/**
 * Plan Page — plan picker for mobile.
 *
 * Mobile has NO in-app payment (per product decision). Picking a plan opens the
 * backend's masked web checkout in an in-app browser via `useWebCheckout`, and
 * the web redirects back to `agentpress://billing/success`, which returns to the
 * app and refreshes the plan. See `hooks/billing/useWebCheckout` + `return-link`.
 */

import React from 'react';
import { View, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Check, X } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Button } from '@/components/ui/button';
import { PRICING_TIERS } from '@/lib/billing/pricing';
import { useWebCheckout } from '@/hooks/billing/useWebCheckout';
import { usePricingModalStore } from '@/stores/billing-modal-store';

interface PlanPageProps {
  visible?: boolean;
  onClose?: () => void;
  onPurchaseComplete?: () => void;
}

/** Feature lines carry markers like `CREDITS_BONUS:2000:4000` — show the total. */
function formatFeature(raw: string): string {
  if (raw.startsWith('CREDITS_BONUS:')) {
    const parts = raw.split(':');
    const total = parts[2] ?? parts[1];
    return `${Number(total).toLocaleString()} monthly credits`;
  }
  // Trim the long "— explanation" tail for a cleaner mobile bullet.
  const dash = raw.indexOf(' - ');
  return dash === -1 ? raw : raw.slice(0, dash);
}

export function PlanPage({ visible = true, onClose }: PlanPageProps) {
  const insets = useSafeAreaInsets();
  const { alertTitle, alertSubtitle } = usePricingModalStore();
  const { upgradeToPlan, pendingTier } = useWebCheckout();

  const tiers = PRICING_TIERS.filter((t) => t.id !== 'free' && !t.hidden);

  if (!visible) return null;

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View
        className="flex-row items-center justify-between border-b border-border/30 px-5"
        style={{ paddingTop: insets.top + 10, paddingBottom: 12 }}>
        <Text variant="large">Upgrade</Text>
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
          Choose a plan — checkout opens securely on the web and brings you right back.
        </Text>

        {tiers.map((tier, i) => {
          const pending = pendingTier === tier.id;
          return (
            <Animated.View
              key={tier.id}
              entering={FadeInDown.delay(i * 60).duration(400)}
              className={`rounded-2xl border bg-secondary/50 p-5 ${
                tier.isPopular ? 'border-kortix-blue' : 'border-border'
              }`}>
              <View className="flex-row items-center gap-2">
                {tier.icon ? <Icon as={tier.icon} size={18} className="text-foreground" /> : null}
                <Text className="font-semibold text-lg">{tier.displayName}</Text>
                {tier.isPopular ? (
                  <View className="ml-1 rounded-full bg-kortix-blue px-2 py-0.5">
                    <Text className="text-[11px] font-medium text-white">Popular</Text>
                  </View>
                ) : null}
              </View>

              <View className="mt-2 flex-row items-baseline gap-1">
                <Text className="font-bold text-3xl">{tier.price}</Text>
                <Text variant="muted">/ month</Text>
              </View>
              {tier.description ? (
                <Text variant="muted" className="mt-1">
                  {tier.description}
                </Text>
              ) : null}

              <View className="mt-4 gap-2">
                {tier.features.map((f) => (
                  <View key={f} className="flex-row items-start gap-2">
                    <Icon as={Check} size={16} className="mt-0.5 text-kortix-green" strokeWidth={2.4} />
                    <Text variant="small" className="flex-1 text-foreground">
                      {formatFeature(f)}
                    </Text>
                  </View>
                ))}
              </View>

              <Button
                variant={tier.isPopular ? 'default' : 'secondary'}
                size="lg"
                className="mt-5 h-12 w-full"
                disabled={pending}
                onPress={() => {
                  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                  void upgradeToPlan(tier.id);
                }}>
                {pending ? <ActivityIndicator size="small" /> : null}
                <Text>{pending ? 'Opening…' : tier.buttonText}</Text>
              </Button>
            </Animated.View>
          );
        })}
      </ScrollView>
    </View>
  );
}
