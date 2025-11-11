/**
 * Pricing Carousel Component
 * 
 * Horizontal scrolling carousel matching Figma design
 * - Center-focused card layout
 * - Snap scrolling
 * - Dots indicator
 * - Monthly/Yearly switcher
 */

import React, { useRef, useState } from 'react';
import { View, ScrollView, Dimensions, Pressable, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { Text } from '@/components/ui/text';
import { PricingTierCard } from './PricingTierCard';
import { PRICING_TIERS, BillingPeriod, getDisplayPrice, type PricingTier } from '@/lib/billing';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const CARD_WIDTH = 245; // From Figma: 245.33px
const CARD_SPACING = 12; // Gap between cards
const SIDE_PADDING = (SCREEN_WIDTH - CARD_WIDTH) / 2; // Center the active card

interface PricingCarouselProps {
  onSelectPlan: (tier: PricingTier) => void;
  selectedPlan: string | null;
  currentPriceId?: string;
  t: (key: string, defaultValue?: string) => string;
}

export function PricingCarousel({
  onSelectPlan,
  selectedPlan,
  currentPriceId,
  t,
}: PricingCarouselProps) {
  const scrollViewRef = useRef<ScrollView>(null);
  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>('monthly');
  const [activeIndex, setActiveIndex] = useState(1); // Start with Pro (middle card)

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const offsetX = event.nativeEvent.contentOffset.x;
    const index = Math.round((offsetX + SIDE_PADDING) / (CARD_WIDTH + CARD_SPACING));
    setActiveIndex(Math.max(0, Math.min(index, PRICING_TIERS.length - 1)));
  };

  const handlePeriodChange = (period: BillingPeriod) => {
    setBillingPeriod(period);
  };

  return (
    <View className="h-full">
      {/* Monthly/Yearly Switcher */}
      <View className="items-center mb-[56px]">
        <View className="flex-row gap-[6px]">
          {/* Monthly Button */}
          <Pressable
            onPress={() => handlePeriodChange('monthly')}
            className={`h-[32px] px-[9px] py-[3px] rounded-[18px] items-center justify-center ${
              billingPeriod === 'monthly'
                ? 'bg-[#121215] dark:bg-[#F8F8F8]'
                : 'border-[0.75px] border-[rgba(0,0,0,0.12)] dark:border-[rgba(255,255,255,0.12)]'
            }`}
          >
            <Text
              className={`text-[12px] font-roobert-medium tracking-[-0.105px] leading-[16.8px] ${
                billingPeriod === 'monthly'
                  ? 'text-[#F8F8F8] dark:text-[#121215]'
                  : 'text-[#121215] dark:text-[#F8F8F8] opacity-80'
              }`}
            >
              Monthly
            </Text>
          </Pressable>

          {/* Yearly Button with Badge */}
          <Pressable
            onPress={() => handlePeriodChange('yearly_commitment')}
            className={`h-[32px] pl-[9px] pr-[3px] py-[3px] rounded-[18px] flex-row items-center gap-[6px] ${
              billingPeriod === 'yearly_commitment'
                ? 'bg-[#121215] dark:bg-[#F8F8F8]'
                : 'border-[0.75px] border-[rgba(0,0,0,0.12)] dark:border-[rgba(255,255,255,0.12)]'
            }`}
          >
            <Text
              className={`text-[12px] font-roobert-medium tracking-[-0.105px] leading-[16.8px] ${
                billingPeriod === 'yearly_commitment'
                  ? 'text-[#F8F8F8] dark:text-[#121215]'
                  : 'text-[#121215] dark:text-[#F8F8F8] opacity-80'
              }`}
            >
              Yearly
            </Text>
            {/* 15% off badge */}
            <View className="bg-[rgba(0,0,0,0.05)] dark:bg-[rgba(255,255,255,0.05)] h-[26px] px-[10px] rounded-[174px] items-center justify-center">
              <Text className="text-[12px] font-roobert-medium text-[#121215] dark:text-[#F8F8F8] leading-[1.5]">
                15% off
              </Text>
            </View>
          </Pressable>
        </View>
      </View>

      {/* Carousel */}
      <ScrollView
        ref={scrollViewRef}
        horizontal
        pagingEnabled={false}
        showsHorizontalScrollIndicator={false}
        snapToInterval={CARD_WIDTH + CARD_SPACING}
        snapToAlignment="center"
        decelerationRate="fast"
        contentContainerStyle={{
          paddingHorizontal: SIDE_PADDING,
          gap: CARD_SPACING,
        }}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        className="flex-1"
      >
        {PRICING_TIERS.map((tier, index) => {
          const displayPrice = getDisplayPrice(tier, billingPeriod);
          const isActive = index === activeIndex;

          return (
            <View
              key={tier.id}
              style={{ width: CARD_WIDTH }}
            >
              <PricingTierCard
                tier={tier}
                displayPrice={displayPrice}
                billingPeriod={billingPeriod}
                currentSubscription={null}
                isLoading={false}
                isFetchingPlan={false}
                onPlanSelect={() => {}}
                onSubscribe={(tierKey) => onSelectPlan(tier)}
                isAuthenticated={false}
                currentBillingPeriod={null}
                insideDialog={false}
                t={t}
              />
            </View>
          );
        })}
      </ScrollView>

      {/* Dots Indicator */}
      <View className="flex-row items-center justify-center gap-[4px] mt-[24px]">
        {PRICING_TIERS.map((_, index) => (
          <View
            key={index}
            className={`rounded-[2323px] ${
              index === activeIndex
                ? 'w-[21px] h-[4px] bg-black dark:bg-white'
                : 'w-[7px] h-[4px] bg-black/25 dark:bg-white/25'
            }`}
          />
        ))}
      </View>
    </View>
  );
}

