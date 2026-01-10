import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { View, Alert, Keyboard, GestureResponderEvent } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Star, X } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomSheetModal, BottomSheetBackdrop, BottomSheetScrollView, BottomSheetTextInput, TouchableOpacity as BottomSheetTouchable } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import * as Haptics from 'expo-haptics';
import { Button } from '@/components/ui/button';
import { CheckCircle2 as CheckIcon } from 'lucide-react-native';
import { API_URL, getAuthHeaders } from '@/api/config';
import { useLanguage } from '@/contexts/LanguageContext';
import { useFeedbackDrawerStore } from '@/stores/feedback-drawer-store';
import { log } from '@/lib/logger';

/**
 * Half-star rating component that supports clicking left/right halves
 */
interface HalfStarRatingProps {
  rating: number | null;
  onRatingChange: (rating: number) => void;
  size?: number;
  disabled?: boolean;
}

function HalfStarRating({ rating, onRatingChange, size = 32, disabled = false }: HalfStarRatingProps) {
  const handleStarPress = useCallback((value: number, event: GestureResponderEvent) => {
    if (disabled) return;
    
    // Get the position of the press relative to the star
    const { locationX } = event.nativeEvent;
    const isLeftHalf = locationX < size / 2;
    const newRating = isLeftHalf ? value - 0.5 : value;
    
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onRatingChange(newRating);
  }, [size, disabled, onRatingChange]);

  return (
    <View className="flex-row items-center justify-center gap-2">
      {[1, 2, 3, 4, 5].map((value) => {
        const fullStarValue = value;
        const halfStarValue = value - 0.5;
        const isFullStar = rating !== null && rating >= fullStarValue;
        const isHalfStar = rating !== null && rating >= halfStarValue && rating < fullStarValue;
        const isEmpty = rating === null || rating < halfStarValue;
        
        return (
          <BottomSheetTouchable
            key={value}
            onPress={(e: any) => handleStarPress(value, e)}
            disabled={disabled}
            style={{ width: size, height: size, position: 'relative' }}
          >
            {/* Base star - outline for empty, filled for full stars */}
            <View className="absolute inset-0">
              <Icon
                as={Star}
                size={size}
                className={isEmpty ? 'text-muted-foreground/30' : 'text-yellow-500'}
                fill={isFullStar ? '#eab308' : 'none'}
              />
            </View>
            
            {/* Half-star overlay (left half filled) - only for half stars */}
            {isHalfStar && (
              <View 
                className="absolute inset-0 overflow-hidden" 
                style={{ width: size / 2 }}
                pointerEvents="none"
              >
                <Icon
                  as={Star}
                  size={size}
                  className="text-yellow-500"
                  fill="#eab308"
                />
              </View>
            )}
          </BottomSheetTouchable>
        );
      })}
    </View>
  );
}

export function FeedbackDrawer() {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const insets = useSafeAreaInsets();
  const bottomSheetModalRef = useRef<BottomSheetModal>(null);
  const wasOpenRef = useRef(false);
  
  const { 
    isOpen, 
    rating: initialRating, 
    threadId, 
    messageId, 
    closeFeedbackDrawer,
    setRating: setStoreRating,
    notifyFeedbackSubmitted
  } = useFeedbackDrawerStore();
  
  // Debug: log on mount and when isOpen changes
  useEffect(() => {
    log.log('🎭 [FeedbackDrawer] Component mounted');
    return () => log.log('🎭 [FeedbackDrawer] Component unmounted');
  }, []);
  
  useEffect(() => {
    log.log('🎭 [FeedbackDrawer] Store state:', { isOpen, initialRating, threadId, messageId });
  }, [isOpen, initialRating, threadId, messageId]);
  
  // Local state - rating can be half values (0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5)
  const [rating, setRating] = useState<number | null>(null);
  const [feedback, setFeedback] = useState('');
  const [helpImprove, setHelpImprove] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  const isDark = colorScheme === 'dark';
  const snapPoints = useMemo(() => ['60%'], []);

  // Sync rating from store
  useEffect(() => {
    if (initialRating !== null) {
      setRating(initialRating);
    }
  }, [initialRating]);

  // Handle visibility changes - use present/dismiss for BottomSheetModal
  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = isOpen;
    
    log.log('🎭 [FeedbackDrawer] isOpen changed:', isOpen, '| wasOpen:', wasOpen);
    
    if (isOpen && !wasOpen) {
      log.log('✅ [FeedbackDrawer] Opening modal...');
      
      // Reset form state
      setFeedback('');
      setHelpImprove(true);
      setIsSubmitting(false);
      
      Keyboard.dismiss();
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      bottomSheetModalRef.current?.present();
    } else if (!isOpen && wasOpen) {
      log.log('❌ [FeedbackDrawer] Closing modal...');
      bottomSheetModalRef.current?.dismiss();
    }
  }, [isOpen]);

  // Modal dismiss handler
  const handleDismiss = useCallback(() => {
    log.log('🎭 [FeedbackDrawer] Modal dismissed');
    closeFeedbackDrawer();
  }, [closeFeedbackDrawer]);

  const handleClose = useCallback(() => {
    Keyboard.dismiss();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    bottomSheetModalRef.current?.dismiss();
  }, []);

  const handleRatingChange = useCallback((newRating: number) => {
    setRating(newRating);
    setStoreRating(newRating);
  }, [setStoreRating]);

  const handleSubmitRating = useCallback(async () => {
    if (!rating || !threadId || !messageId || isSubmitting) return;

    setIsSubmitting(true);
    Keyboard.dismiss();
    
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(`${API_URL}/feedback`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          rating,
          feedback_text: feedback.trim() || null,
          help_improve: helpImprove,
          thread_id: threadId,
          message_id: messageId
        }),
      });

      if (response.ok) {
        // Notify store so TaskCompletedFeedback can refetch
        notifyFeedbackSubmitted(threadId, messageId, rating);
        
        bottomSheetModalRef.current?.dismiss();
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        // Show success message
        Alert.alert(
          t('chat.feedbackSubmittedTitle', { defaultValue: 'Thank you!' }),
          t('chat.feedbackSubmittedMessage', { defaultValue: 'Your feedback has been submitted successfully.' })
        );
      } else {
        const errorData = await response.json().catch(() => ({ message: response.statusText }));
        const errorMessage = errorData.detail?.message || errorData.message || t('chat.feedbackSubmitFailed');
        Alert.alert(t('chat.error', { defaultValue: 'Error' }), errorMessage);
      }
    } catch (error) {
      log.error('Error submitting feedback:', error);
      Alert.alert(
        t('chat.error', { defaultValue: 'Error' }), 
        t('chat.feedbackSubmitFailedRetry', { defaultValue: 'Failed to submit feedback. Please try again.' })
      );
    } finally {
      setIsSubmitting(false);
    }
  }, [rating, feedback, helpImprove, threadId, messageId, isSubmitting, t, notifyFeedbackSubmitted]);

  const handleToggleHelpImprove = useCallback(() => {
    setHelpImprove(prev => !prev);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, []);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={0.5}
        pressBehavior="close"
      />
    ),
    []
  );

  // Rating display text
  const ratingText = rating !== null ? (
    rating === Math.floor(rating) ? `${rating}.0` : `${rating}`
  ) : null;

  return (
    <BottomSheetModal
      ref={bottomSheetModalRef}
      snapPoints={snapPoints}
      enablePanDownToClose
      onDismiss={handleDismiss}
      backdropComponent={renderBackdrop}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
      backgroundStyle={{
        backgroundColor: isDark ? '#161618' : '#FFFFFF',
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
        contentContainerStyle={{
          paddingHorizontal: 24,
          paddingTop: 8,
          paddingBottom: Math.max(insets.bottom, 20) + 16,
        }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* Header */}
        <View className="flex-row items-center justify-between mb-6">
          <View className="flex-1">
            <Text className="text-xl font-roobert-semibold text-foreground mb-1">
              {t('chat.howWasThisResult', { defaultValue: 'Rate this result' })}
            </Text>
            <Text className="text-sm font-roobert text-muted-foreground">
              {t('chat.feedbackHelpsImprove', { defaultValue: 'Your feedback helps improve Kortix' })}
            </Text>
          </View>
          <BottomSheetTouchable
            onPress={handleClose}
            style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 16 }}
          >
            <Icon as={X} size={20} className="text-muted-foreground" />
          </BottomSheetTouchable>
        </View>

        {/* Star Rating with half-star support */}
        <View className="py-4 mb-2">
          <HalfStarRating
            rating={rating}
            onRatingChange={handleRatingChange}
            size={36}
            disabled={isSubmitting}
          />
          {ratingText && (
            <Text className="text-center text-sm font-roobert text-muted-foreground mt-2">
              {ratingText} / 5
            </Text>
          )}
        </View>

        {/* Feedback Textarea */}
        <View className="mb-4">
          <Text className="text-sm font-roobert-medium text-foreground mb-2">
            {t('chat.additionalFeedback', { defaultValue: 'Additional feedback' })}
            <Text className="text-muted-foreground"> ({t('common.optional', { defaultValue: 'optional' })})</Text>
          </Text>
          <BottomSheetTextInput
            placeholder={t('chat.additionalFeedbackPlaceholder', { defaultValue: 'Tell us more about your experience...' })}
            placeholderTextColor={isDark ? '#71717A' : '#A1A1AA'}
            value={feedback}
            onChangeText={setFeedback}
            multiline
            numberOfLines={4}
            editable={!isSubmitting}
            style={{
              minHeight: 100,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: isDark ? '#27272A' : '#E4E4E7',
              backgroundColor: isDark ? '#1F1F23' : '#FAFAFA',
              paddingHorizontal: 16,
              paddingTop: 12,
              paddingBottom: 12,
              fontSize: 14,
              fontFamily: 'Roobert-Regular',
              color: isDark ? '#FAFAFA' : '#18181B',
              textAlignVertical: 'top',
            }}
          />
        </View>

        {/* Help Improve Checkbox */}
        <BottomSheetTouchable
          onPress={handleToggleHelpImprove}
          disabled={isSubmitting}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, marginBottom: 24 }}
        >
          <View className={`w-5 h-5 rounded border-2 items-center justify-center ${
            helpImprove 
              ? 'bg-primary border-primary' 
              : isDark ? 'border-zinc-600 bg-transparent' : 'border-zinc-300 bg-transparent'
          }`}>
            {helpImprove && (
              <Icon as={CheckIcon} size={14} className="text-primary-foreground" />
            )}
          </View>
          <Text className="text-sm font-roobert text-foreground flex-1">
            {t('chat.helpKortixImprove', { defaultValue: 'Help Kortix improve with this feedback' })}
          </Text>
        </BottomSheetTouchable>

        {/* Action Buttons */}
        <View className="flex-row gap-3">
          <Button
            variant="outline"
            onPress={handleClose}
            disabled={isSubmitting}
            className="flex-1"
          >
            <Text>{t('common.cancel', { defaultValue: 'Cancel' })}</Text>
          </Button>
          <Button
            onPress={handleSubmitRating}
            disabled={!rating || isSubmitting}
            className="flex-1"
          >
            <Text>
              {isSubmitting 
                ? t('chat.submitting', { defaultValue: 'Submitting...' }) 
                : t('chat.submit', { defaultValue: 'Submit' })
              }
            </Text>
          </Button>
        </View>
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}
