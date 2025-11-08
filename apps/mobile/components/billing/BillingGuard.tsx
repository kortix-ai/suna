/**
 * Billing Guard Component
 *
 * Monitors billing status and automatically shows billing modal when needed
 * Provides seamless subscription prompts without disrupting user experience
 */

import React, { useEffect, useState, useCallback } from 'react';
import { View } from 'react-native';
import { useSegments, useRouter } from 'expo-router';
import { useBillingContext } from '@/contexts/BillingContext';
import { BillingModal } from './BillingModal';
import { useFocusEffect } from '@react-navigation/native';

export function BillingGuard() {
  const { needsSubscription, hasActiveTrial, hasActiveSubscription, isLoading, checkBillingStatus } = useBillingContext();
  const segments = useSegments();
  const router = useRouter();
  const [showBillingModal, setShowBillingModal] = useState(false);
  const [canDismissModal, setCanDismissModal] = useState(true);
  const [lastBillingCheck, setLastBillingCheck] = useState(0);

  // Screen exclusions where we don't show billing modal
  const excludedScreens = ['auth', 'onboarding', 'index', 'billing', 'credits'];

  const isOnExcludedScreen = excludedScreens.some(screen =>
    segments.some(segment => segment.includes(screen))
  );

  // Check if we should show billing modal
  const shouldShowBillingModal = React.useMemo(() => {
    if (isLoading) return false;
    if (isOnExcludedScreen) return false;
    if (hasActiveSubscription) return false;
    if (hasActiveTrial) return false;

    return needsSubscription;
  }, [needsSubscription, hasActiveTrial, hasActiveSubscription, isLoading, isOnExcludedScreen]);

  // Periodic billing check (every 5 minutes)
  useEffect(() => {
    const checkInterval = setInterval(() => {
      const now = Date.now();
      if (now - lastBillingCheck > 5 * 60 * 1000) { // 5 minutes
        console.log('💳 Periodic billing check...');
        checkBillingStatus().then((canProceed) => {
          if (!canProceed && !isOnExcludedScreen) {
            console.log('❌ Billing check failed, showing modal');
            setShowBillingModal(true);
            setCanDismissModal(false); // Force subscription if credits exhausted
          }
          setLastBillingCheck(now);
        }).catch((error) => {
          console.error('❌ Periodic billing check error:', error);
        });
      }
    }, 30 * 1000); // Check every 30 seconds

    return () => clearInterval(checkInterval);
  }, [checkBillingStatus, isOnExcludedScreen, lastBillingCheck]);

  // Show modal when billing status changes
  useEffect(() => {
    if (shouldShowBillingModal) {
      console.log('💳 Showing billing modal - user needs subscription');
      setShowBillingModal(true);
      setCanDismissModal(!hasActiveTrial); // Can dismiss if trial available
    } else {
      setShowBillingModal(false);
    }
  }, [shouldShowBillingModal, hasActiveTrial]);

  const handleBillingModalDismiss = useCallback(() => {
    if (canDismissModal) {
      console.log('💳 Billing modal dismissed');
      setShowBillingModal(false);
    }
  }, [canDismissModal]);

  const handleBillingSuccess = useCallback(() => {
    console.log('✅ Billing success - refreshing status');
    setShowBillingModal(false);
    // Status will auto-refresh via context
  }, []);

  // Reset modal state when screen changes
  useFocusEffect(
    useCallback(() => {
      if (isOnExcludedScreen && showBillingModal) {
        console.log('📱 On excluded screen, hiding billing modal');
        setShowBillingModal(false);
      }
    }, [isOnExcludedScreen, showBillingModal])
  );

  return (
    <View className="absolute inset-0 pointer-events-none z-50">
      <BillingModal
        visible={showBillingModal}
        onDismiss={handleBillingModalDismiss}
        canDismiss={canDismissModal}
        onSuccess={handleBillingSuccess}
      />
    </View>
  );
}
