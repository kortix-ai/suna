import React, { useState } from 'react';
import { View, Pressable, Modal, ScrollView, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { AlertCircle } from 'lucide-react-native';
import { formatCredits } from '@/lib/utils/credit-formatter';
import { startUnifiedCreditPurchase, invalidateCreditsAfterPurchase } from '@/lib/billing';
import * as Haptics from 'expo-haptics';
import { useQueryClient } from '@tanstack/react-query';

interface CreditPurchaseModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentBalance?: number;
  canPurchase: boolean;
  onPurchaseComplete?: () => void;
}

interface CreditPackage {
  amount: number;
  price: number;
  popular?: boolean;
}

const CREDIT_PACKAGES: CreditPackage[] = [
  { amount: 10, price: 10 },
  { amount: 25, price: 25 },
  { amount: 50, price: 50 },
  { amount: 100, price: 100, popular: true },
  { amount: 250, price: 250 },
  { amount: 500, price: 500 },
];

export function CreditPurchaseModal({
  open,
  onOpenChange,
  currentBalance = 0,
  canPurchase,
  onPurchaseComplete
}: CreditPurchaseModalProps) {
  const [selectedPackage, setSelectedPackage] = useState<CreditPackage | null>(null);
  const [customAmount, setCustomAmount] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const handlePurchase = async (amount: number) => {
    if (amount < 10) {
      setError('Minimum purchase amount is $10');
      return;
    }
    if (amount > 5000) {
      setError('Maximum purchase amount is $5000');
      return;
    }
    setIsProcessing(true);
    setError(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    
    try {
      await startUnifiedCreditPurchase(
        amount,
        () => {
          setIsProcessing(false);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          invalidateCreditsAfterPurchase(queryClient);
          onPurchaseComplete?.();
          onOpenChange(false);
          setSelectedPackage(null);
          setCustomAmount('');
        },
        () => {
          setIsProcessing(false);
        }
      );
    } catch (err: any) {
      console.error('Credit purchase error:', err);
      const errorMessage = err?.details?.detail || err?.message || 'Failed to create checkout session';
      setError(errorMessage);
      setIsProcessing(false);
    }
  };

  const handlePackageSelect = (pkg: CreditPackage) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedPackage(pkg);
    setCustomAmount('');
    setError(null);
  };

  const handleCustomAmountChange = (value: string) => {
    setCustomAmount(value);
    setSelectedPackage(null);
    setError(null);
  };

  const handleConfirmPurchase = () => {
    const amount = selectedPackage ? selectedPackage.amount : parseFloat(customAmount);
    if (!isNaN(amount)) {
      handlePurchase(amount);
    } else {
      setError('Please select a package or enter a valid amount');
    }
  };

  const handleClose = () => {
    if (isProcessing) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onOpenChange(false);
    // Reset state on close
    setTimeout(() => {
      setSelectedPackage(null);
      setCustomAmount('');
      setError(null);
    }, 300);
  };

  if (!canPurchase) {
    return (
      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={handleClose}
      >
        <View className="flex-1 bg-black/50 items-center justify-center px-6">
          <View className="bg-card border border-border rounded-[18px] p-6 max-w-md w-full">
            <Text className="text-xl font-roobert-semibold text-foreground mb-2">
              Credits Not Available
            </Text>
            <Text className="text-sm font-roobert text-muted-foreground mb-4">
              Credit purchases are only available for users on the $200/month subscription tier.
            </Text>
            <View className="bg-destructive/10 border border-destructive/20 rounded-lg p-4 mb-4">
              <View className="flex-row items-start gap-2">
                <Icon as={AlertCircle} size={16} className="text-destructive mt-0.5" strokeWidth={2} />
                <Text className="flex-1 text-sm font-roobert text-destructive">
                  Please upgrade your subscription to the $200/month tier to unlock credit purchases for unlimited usage.
                </Text>
              </View>
            </View>
            <Pressable
              onPress={handleClose}
              className="h-10 border border-border rounded-lg items-center justify-center"
            >
              <Text className="text-sm font-roobert-medium text-foreground">
                Close
              </Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    );
  }

  return (
    <Modal
      visible={open}
      transparent
      animationType="fade"
      onRequestClose={handleClose}
    >
      <Pressable 
        className="flex-1 bg-black/50 items-center justify-center px-6"
        onPress={handleClose}
      >
        <Pressable 
          className="bg-card border border-border rounded-[18px] p-6 max-w-2xl w-full"
          onPress={(e) => e.stopPropagation()}
        >
          <ScrollView showsVerticalScrollIndicator={false}>
            {/* Header */}
            <View className="mb-4">
              <Text className="text-xl font-roobert-semibold text-foreground mb-1">
                Get additional credits
              </Text>
              <Text className="text-sm font-roobert text-muted-foreground">
                Add credits to your account for usage beyond your subscription limit.
              </Text>
            </View>

            {/* Current Balance */}
            {currentBalance > 0 && (
              <View className="mb-4">
                <Text className="text-sm font-roobert text-muted-foreground">
                  Current balance: {formatCredits(currentBalance, { showDecimals: true })}
                </Text>
              </View>
            )}

            {/* Credit Packages Grid */}
            <View className="mb-4">
              <View className="flex-row flex-wrap gap-3">
                {CREDIT_PACKAGES.map((pkg) => (
                  <Pressable
                    key={pkg.amount}
                    onPress={() => handlePackageSelect(pkg)}
                    className={`flex-1 min-w-[100px] bg-card border rounded-lg p-4 items-center ${
                      selectedPackage?.amount === pkg.amount
                        ? 'border-primary border-2'
                        : 'border-border'
                    }`}
                  >
                    <Text className="text-xl font-roobert-semibold text-foreground">
                      ${pkg.amount}
                    </Text>
                    <Text className="text-xs font-roobert text-muted-foreground mt-1">
                      Credits
                    </Text>
                    {pkg.popular && (
                      <View className="mt-1 bg-primary/10 px-2 py-0.5 rounded-full">
                        <Text className="text-[10px] font-roobert-medium text-primary">
                          Popular
                        </Text>
                      </View>
                    )}
                  </Pressable>
                ))}
              </View>
            </View>

            {/* Error Alert */}
            {error && (
              <View className="mb-4 bg-destructive/10 border border-destructive/20 rounded-lg p-4">
                <View className="flex-row items-start gap-2">
                  <Icon as={AlertCircle} size={16} className="text-destructive mt-0.5" strokeWidth={2} />
                  <Text className="flex-1 text-sm font-roobert text-destructive">
                    {error}
                  </Text>
                </View>
              </View>
            )}

            {/* Continue Button */}
            <View className="items-center mt-6">
              <Pressable
                onPress={handleConfirmPurchase}
                disabled={isProcessing || (!selectedPackage && !customAmount)}
                className={`h-10 px-8 rounded-lg items-center justify-center min-w-[120px] ${
                  isProcessing || (!selectedPackage && !customAmount)
                    ? 'bg-muted opacity-50'
                    : 'bg-primary'
                }`}
              >
                {isProcessing ? (
                  <View className="flex-row items-center gap-2">
                    <ActivityIndicator size="small" color="#fff" />
                    <Text className="text-sm font-roobert-medium text-primary-foreground">
                      Processing...
                    </Text>
                  </View>
                ) : (
                  <Text className="text-sm font-roobert-medium text-primary-foreground">
                    Continue
                  </Text>
                )}
              </Pressable>
            </View>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

