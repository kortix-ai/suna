import React, { useCallback, useEffect, useRef } from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
} from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { LinearGradient } from 'expo-linear-gradient';
import { ArrowRight, Asterisk, UserPlus } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useSandboxContext } from '@/contexts/SandboxContext';
import { useAccountState } from '@/lib/billing/hooks';
import { haptics } from '@/lib/haptics';
import { getUpgradeGate } from '@/lib/billing/upgrade-gate';
import { getUpgradeSheetTransition } from '@/lib/billing/upgrade-sheet-lifecycle';
import { getTeamUpgradeOffer } from '@/lib/billing/team-upgrade-offer';
import { getSheetBg } from '@/lib/theme-colors';
import { useUpgradeSheetStore } from '@/stores/upgrade-sheet-store';
import { Badge, Button } from '../ui';



/** Opens the upgrade sheet when the root sandbox bootstrap is blocked by billing. */
export function SandboxUpgradeGateListener() {
  const { error } = useSandboxContext();
  const openUpgradeSheet = useUpgradeSheetStore((state) => state.openUpgradeSheet);
  const handledError = useRef<Error | null>(null);

  useEffect(() => {
    const gate = getUpgradeGate(error);
    if (!gate || error === handledError.current) return;

    handledError.current = error as Error;
    openUpgradeSheet(gate);
  }, [error, openUpgradeSheet]);

  return null;
}

/** Global native counterpart to the web upgrade modal. */
export function GlobalUpgradeSheet() {
  const sheetRef = useRef<BottomSheetModal>(null);
  const wasPresentedRef = useRef(false);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const { isOpen, accountId, message, closeUpgradeSheet } = useUpgradeSheetStore();
  const { data: accountState } = useAccountState({
    accountId: accountId ?? undefined,
    enabled: isOpen,
  });
  const offer = getTeamUpgradeOffer(accountState);
  const included = [
    `$${offer.pricePerSeat} of usage credit per teammate, every month`,
    'Every model — drawn from one shared team wallet',
    'AI Computers to run code, browsers, and terminals',
    'Spend on compute, LLM, or both — one wallet, auto top-up',
    'Auto-prorated as teammates join or leave',
  ];

  useEffect(() => {
    const transition = getUpgradeSheetTransition(isOpen, wasPresentedRef.current);
    if (transition === 'present') {
      wasPresentedRef.current = true;
      const frame = requestAnimationFrame(() => sheetRef.current?.present());
      return () => cancelAnimationFrame(frame);
    }
    if (transition === 'dismiss') {
      wasPresentedRef.current = false;
      sheetRef.current?.dismiss();
    }
  }, [isOpen]);

  const handleDismiss = useCallback(() => {
    wasPresentedRef.current = false;
    closeUpgradeSheet();
  }, [closeUpgradeSheet]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} opacity={0.5} />
    ),
    [],
  );

  const handleViewPlans = useCallback(() => {
    haptics.medium();
    closeUpgradeSheet();
    router.push('/plans');
  }, [closeUpgradeSheet, router]);

  return (
    <BottomSheetModal
      ref={sheetRef}
      snapPoints={['88%']}
      enableDynamicSizing={false}
      enablePanDownToClose
      onDismiss={handleDismiss}
      backdropComponent={renderBackdrop}
      backgroundStyle={{
        backgroundColor: getSheetBg(isDark),
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
      }}
      handleIndicatorStyle={{
        backgroundColor: isDark ? '#3F3F46' : '#D4D4D8',
        width: 36,
        height: 5,
        borderRadius: 3,
      }}
    >
      <BottomSheetScrollView
        contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 12, paddingBottom: insets.bottom + 20 }}
      >

        <Badge variant="secondary" className='w-fit self-start rounded  px-2 py-0'>
          <Text className='text-foreground' style={{
            fontFamily: 'Roobert-Medium',
            fontSize: 12,
          }}>
          KORTIX TEAM
          </Text>
        </Badge>

        <View className="mt-4">
          <Text
            className="text-foreground"
            style={{ fontFamily: 'Roobert-SemiBold', fontSize: 48, lineHeight: 48, letterSpacing: -2, fontVariant: ['tabular-nums'] }}
          >
            ${offer.pricePerSeat}
          </Text>
          <Text className="mt-1 text-sm text-muted-foreground">per seat · billed monthly</Text>
          <Text className="mt-4 text-sm leading-5 text-muted-foreground">
            LLM compute and AI Computers for every teammate. Add seats as your team grows.
          </Text>
        </View>

        <View className="mt-7 gap-3 ">
          {included.map((item) => (
            <View key={item} className="flex-row items-start">
              <Text className="mr-2.5 text-sm leading-5 text-foreground">•</Text>
              <Text className="flex-1 text-sm leading-5 text-foreground">{item}</Text>
            </View>
          ))}
        </View>

        <View
          className="mt-7 border-t pt-5"
          style={{ borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(18,18,21,0.1)' }}
        >
          {offer.hasSeatMath && (
            <View className="mb-4 flex-row items-center justify-between">
              <Text className="text-sm text-muted-foreground">
                {offer.seatCount} {offer.seatCount === 1 ? 'seat' : 'seats'} × ${offer.pricePerSeat}
              </Text>
              <Text className="font-roobert-medium text-sm text-foreground">${offer.monthlyTotal}/mo</Text>
            </View>
          )}

          {offer.canManageBilling ? (
            <>
              <Button onPress={handleViewPlans} className="w-full ">
                <Text>
                  {offer.hasSeatMath
                    ? `Subscribe — $${offer.monthlyTotal}/mo`
                    : `Subscribe — $${offer.pricePerSeat}/seat`}
                </Text>
                <Icon as={ArrowRight} size={17} className="text-primary-foreground" strokeWidth={2.2} />
              </Button>
              <Text className="mt-3 text-center text-xs text-muted-foreground">
                Auto-prorated · cancel anytime · billed monthly
              </Text>
            </>
          ) : (
            <View
              className="flex-row gap-3 rounded-xl border p-4"
              style={{ borderColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(18,18,21,0.12)' }}
            >
              <Icon as={UserPlus} size={19} color={isDark ? '#FFFFFF' : '#000000'} strokeWidth={2.1} />
              <View className="flex-1">
                <Text className="font-roobert-medium text-sm text-foreground">Ask an account owner for a seat</Text>
                <Text className="mt-1 text-xs leading-4 text-muted-foreground">
                  Only account owners can subscribe. Your seat activates automatically once they do.
                </Text>
              </View>
            </View>
          )}

          {message && (
            <Text className="mt-4 text-center text-xs leading-4 text-muted-foreground">{message}</Text>
          )}
          <Pressable
            onPress={closeUpgradeSheet}
            className="mt-3 items-center rounded-full px-5 py-3 active:opacity-70"
          >
            <Text className="font-roobert-medium text-sm text-muted-foreground">Not now</Text>
          </Pressable>
        </View>
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}
