import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { View, Pressable, TextInput, Alert, Keyboard } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Star, X } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomSheetModal, BottomSheetBackdrop, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import * as Haptics from 'expo-haptics';
import { Button } from '@/components/ui/button';
import { CheckCircle2 as CheckIcon } from 'lucide-react-native';
import { API_URL, getAuthHeaders } from '@/api/config';
import { useLanguage } from '@/contexts/LanguageContext';
import { useFeedbackDrawerStore } from '@/stores/feedback-drawer-store';

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
    setRating: setStoreRating
  } = useFeedbackDrawerStore();
  
  // Debug: log on mount and when isOpen changes
  useEffect(() => {
    console.log('🎭 [FeedbackDrawer] Component mounted');
    return () => console.log('🎭 [FeedbackDrawer] Component unmounted');
  }, []);
  
  useEffect(() => {
    console.log('🎭 [FeedbackDrawer] Store state:', { isOpen, initialRating, threadId, messageId });
  }, [isOpen, initialRating, threadId, messageId]);
  
  // Local state
  const [rating, setRating] = useState<number | null>(null);
  const [feedback, setFeedback] = useState('');
  const [helpImprove, setHelpImprove] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  const isDark = colorScheme === 'dark';
  const snapPoints = useMemo(() => ['55%'], []);

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
    
    console.log('🎭 [FeedbackDrawer] isOpen changed:', isOpen, '| wasOpen:', wasOpen);
    
    if (isOpen && !wasOpen) {
      console.log('✅ [FeedbackDrawer] Opening modal...');
      
      // Reset form state
      setFeedback('');
      setHelpImprove(true);
      setIsSubmitting(false);
      
      Keyboard.dismiss();
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      bottomSheetModalRef.current?.present();
    } else if (!isOpen && wasOpen) {
      console.log('❌ [FeedbackDrawer] Closing modal...');
      bottomSheetModalRef.current?.dismiss();
    }
  }, [isOpen]);

  // Modal dismiss handler
  const handleDismiss = useCallback(() => {
    console.log('🎭 [FeedbackDrawer] Modal dismissed');
    closeFeedbackDrawer();
  }, [closeFeedbackDrawer]);

  const handleClose = useCallback(() => {
    Keyboard.dismiss();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    bottomSheetModalRef.current?.dismiss();
  }, []);

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
        bottomSheetModalRef.current?.dismiss();
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } else {
        const errorData = await response.json().catch(() => ({ message: response.statusText }));
        const errorMessage = errorData.detail?.message || errorData.message || t('chat.feedbackSubmitFailed');
        Alert.alert(t('chat.error'), errorMessage);
      }
    } catch (error) {
      console.error('Error submitting feedback:', error);
      Alert.alert(t('chat.error'), t('chat.feedbackSubmitFailedRetry'));
    } finally {
      setIsSubmitting(false);
    }
  }, [rating, feedback, helpImprove, threadId, messageId, isSubmitting, t]);

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
              {t('chat.howWasThisResult')}
            </Text>
            <Text className="text-sm font-roobert text-muted-foreground">
              {t('chat.feedbackHelpsImprove')}
            </Text>
          </View>
          <Pressable
            onPress={handleClose}
            className="w-8 h-8 items-center justify-center rounded-full active:bg-muted/50"
            hitSlop={8}
          >
            <Icon as={X} size={20} className="text-muted-foreground" />
          </Pressable>
        </View>

        {/* Star Rating */}
        <View className="flex-row items-center justify-center gap-3 py-4 mb-4">
          {[1, 2, 3, 4, 5].map((value) => {
            const isFilled = rating !== null && rating >= value;
            
            return (
              <Pressable
                key={value}
                onPress={() => {
                  setRating(value);
                  setStoreRating(value);
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                }}
                className="active:opacity-70"
                disabled={isSubmitting}
              >
                <Icon
                  as={Star}
                  size={32}
                  className={isFilled ? 'text-yellow-500 fill-current' : 'text-muted-foreground/30'}
                />
              </Pressable>
            );
          })}
        </View>

        {/* Feedback Textarea */}
        <View className="mb-4">
          <TextInput
            placeholder={t('chat.additionalFeedbackOptional')}
            placeholderTextColor={isDark ? '#71717A' : '#A1A1AA'}
            value={feedback}
            onChangeText={setFeedback}
            multiline
            numberOfLines={4}
            editable={!isSubmitting}
            className="min-h-[100px] rounded-xl border border-border bg-muted/30 dark:bg-muted/20 px-4 py-3 text-foreground font-roobert text-sm"
            style={{
              textAlignVertical: 'top',
              color: isDark ? '#FAFAFA' : '#18181B',
            }}
            textAlignVertical="top"
          />
        </View>

        {/* Help Improve Checkbox */}
        <Pressable
          onPress={handleToggleHelpImprove}
          disabled={isSubmitting}
          className="flex-row items-center gap-3 py-2 mb-6"
        >
          <View className={`w-5 h-5 rounded border-2 items-center justify-center ${
            helpImprove 
              ? 'bg-primary border-primary' 
              : 'border-border bg-transparent'
          }`}>
            {helpImprove && (
              <Icon as={CheckIcon} size={14} className="text-primary-foreground" />
            )}
          </View>
          <Text className="text-sm font-roobert text-foreground flex-1">
            {t('chat.helpKortixImprove')}
          </Text>
        </Pressable>

        {/* Action Buttons */}
        <View className="flex-row gap-3">
          <Button
            variant="outline"
            onPress={handleClose}
            disabled={isSubmitting}
            className="flex-1"
          >
            <Text>{t('common.cancel')}</Text>
          </Button>
          <Button
            onPress={handleSubmitRating}
            disabled={!rating || isSubmitting}
            className="flex-1"
          >
            <Text>{isSubmitting ? t('chat.submitting') : t('chat.submit')}</Text>
          </Button>
        </View>
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}

