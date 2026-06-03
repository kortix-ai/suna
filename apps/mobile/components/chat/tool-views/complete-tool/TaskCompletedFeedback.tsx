import React, { useState, useCallback, useEffect, useRef } from 'react';
import { View, PanResponder } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { CheckCircle2, Star } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { API_URL, getAuthHeaders } from '@/api/config';
import { useLanguage } from '@/contexts/LanguageContext';
import { PromptExamples } from '@/components/shared';
import { log } from '@/lib/logger';

interface MessageFeedback {
  feedback_id: string;
  thread_id?: string;
  message_id?: string;
  account_id: string;
  rating: number; // Can be 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5
  feedback_text?: string;
  help_improve: boolean;
  context?: Record<string, any>;
  created_at: string;
  updated_at: string;
}

interface TaskCompletedFeedbackProps {
  taskSummary?: string;
  followUpPrompts?: string[];
  onFollowUpClick?: (prompt: string) => void;
  samplePromptsTitle?: string;
  threadId?: string;
  messageId?: string | null;
}

/**
 * Inline half-star rating display with swipe-to-rate functionality
 * Supports half-star ratings (0.5, 1.5, 2.5, etc.) like the frontend
 * Users can tap or swipe across the stars to select a rating
 */
function InlineStarRating({
  currentRating,
  onStarClick,
  disabled
}: {
  currentRating: number | null;
  onStarClick: (value: number) => void;
  disabled: boolean;
}) {
  const starSize = 20; // Slightly bigger than original 16 for better swipe interaction
  const starGap = 4; // Gap between stars in pixels
  const numStars = 5;
  const containerRef = useRef<View>(null);
  const [previewRating, setPreviewRating] = useState<number | null>(null);
  const lastHapticRating = useRef<number | null>(null);

  // Calculate rating from touch position
  const calculateRatingFromPosition = useCallback((x: number) => {
    const totalWidth = (starSize * numStars) + (starGap * (numStars - 1));

    // Normalize x to be within bounds
    const clampedX = Math.max(0, Math.min(x, totalWidth));

    // Calculate which star and position within that star
    const position = clampedX / totalWidth;
    const rating = position * numStars;

    // Round to nearest 0.5
    const roundedRating = Math.round(rating * 2) / 2;

    // Ensure rating is between 0.5 and 5
    return Math.max(0.5, Math.min(5, roundedRating));
  }, [starSize, starGap, numStars]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !disabled,
      onMoveShouldSetPanResponder: () => !disabled,

      onPanResponderGrant: (evt) => {
        if (disabled) return;

        // Get touch position relative to the container
        containerRef.current?.measure((_x, _y, _width, _height, pageX, _pageY) => {
          const touchX = evt.nativeEvent.pageX - pageX;
          const rating = calculateRatingFromPosition(touchX);
          setPreviewRating(rating);
          lastHapticRating.current = rating;
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        });
      },

      onPanResponderMove: (evt) => {
        if (disabled) return;

        containerRef.current?.measure((_x, _y, _width, _height, pageX, _pageY) => {
          const touchX = evt.nativeEvent.pageX - pageX;
          const rating = calculateRatingFromPosition(touchX);
          setPreviewRating(rating);

          // Provide haptic feedback when rating changes
          if (lastHapticRating.current !== rating) {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            lastHapticRating.current = rating;
          }
        });
      },

      onPanResponderRelease: (evt) => {
        if (disabled) return;

        containerRef.current?.measure((_x, _y, _width, _height, pageX, _pageY) => {
          const touchX = evt.nativeEvent.pageX - pageX;
          const rating = calculateRatingFromPosition(touchX);

          // Final haptic feedback
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

          // Clear preview and submit rating
          setPreviewRating(null);
          lastHapticRating.current = null;

          // Small delay to let gesture system settle
          setTimeout(() => {
            onStarClick(rating);
          }, 50);
        });
      },

      onPanResponderTerminate: () => {
        setPreviewRating(null);
        lastHapticRating.current = null;
      },
    })
  ).current;

  // Show preview rating while swiping, otherwise show current rating
  const displayRating = previewRating !== null ? previewRating : currentRating;

  return (
    <View
      ref={containerRef}
      {...panResponder.panHandlers}
      className="flex-row items-center"
      style={{ gap: starGap }}
    >
      {[1, 2, 3, 4, 5].map((value) => {
        const fullStarValue = value;
        const halfStarValue = value - 0.5;
        const isFullStar = displayRating !== null && displayRating >= fullStarValue;
        const isHalfStar = displayRating !== null && displayRating >= halfStarValue && displayRating < fullStarValue;
        const isEmpty = displayRating === null || displayRating < halfStarValue;

        return (
          <View
            key={value}
            className="relative"
            style={{ width: starSize, height: starSize }}
          >
            {/* Base star - outline for empty, filled for full stars */}
            <View className="absolute inset-0">
              <Icon
                as={Star}
                size={starSize}
                className={isEmpty ? 'text-muted-foreground/30' : 'text-yellow-500'}
                fill={isFullStar ? '#eab308' : 'none'}
              />
            </View>

            {/* Half-star overlay (left half filled) - only for half stars */}
            {isHalfStar && (
              <View
                className="absolute inset-0 overflow-hidden"
                style={{ width: starSize / 2 }}
                pointerEvents="none"
              >
                <Icon
                  as={Star}
                  size={starSize}
                  className="text-yellow-500"
                  fill="#eab308"
                />
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

export function TaskCompletedFeedback({
  followUpPrompts,
  onFollowUpClick,
  samplePromptsTitle,
  threadId,
  messageId
}: TaskCompletedFeedbackProps) {
  const { t } = useLanguage();

  // State
  const [submittedFeedback, setSubmittedFeedback] = useState<MessageFeedback | null>(null);
  const [isSubmittingFeedback, setIsSubmittingFeedback] = useState(false);

  // Fetch feedback function
  const fetchFeedback = useCallback(async () => {
    if (!threadId || !messageId) return;

    try {
      const headers = await getAuthHeaders();
      const params = new URLSearchParams();
      params.append('thread_id', threadId);
      params.append('message_id', messageId);

      const response = await fetch(`${API_URL}/feedback?${params.toString()}`, {
        method: 'GET',
        headers,
      });

      if (response.ok) {
        const data: MessageFeedback[] = await response.json();
        if (data && data.length > 0) {
          setSubmittedFeedback(data[0]);
          log.log('✅ [TaskCompletedFeedback] Fetched feedback:', data[0].rating);
        }
      }
    } catch (error) {
      log.error('Error fetching feedback:', error);
    }
  }, [threadId, messageId]);

  // Initial fetch on mount
  useEffect(() => {
    if (!threadId || !messageId) return;
    fetchFeedback();
  }, [threadId, messageId, fetchFeedback]);

  const handleStarClick = useCallback(async (value: number) => {
    log.log('⭐ Star clicked:', value, { submittedFeedback, threadId, messageId });
    if (submittedFeedback || isSubmittingFeedback || !threadId || !messageId) return;

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsSubmittingFeedback(true);

    try {
      const headers = await getAuthHeaders();
      const response = await fetch(`${API_URL}/feedback`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          rating: value,
          feedback_text: null,
          help_improve: true,
          thread_id: threadId,
          message_id: messageId,
        }),
      });

      if (!response.ok) {
        throw new Error(`Feedback request failed with ${response.status}`);
      }

      setSubmittedFeedback({
        feedback_id: 'temp',
        thread_id: threadId,
        message_id: messageId,
        account_id: '',
        rating: value,
        help_improve: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      fetchFeedback();
    } catch (error) {
      log.error('Error submitting feedback:', error);
    } finally {
      setIsSubmittingFeedback(false);
    }
  }, [submittedFeedback, isSubmittingFeedback, threadId, messageId, fetchFeedback]);

  const currentRating = submittedFeedback?.rating ?? null;

  return (
    <View className="gap-4 mt-4">
      {/* Rating Section */}
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center gap-2">
          <Icon as={CheckCircle2} size={16} className="text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
          <Text className="text-sm font-roobert text-muted-foreground">
            {t('chat.taskCompleted', { defaultValue: 'Task completed' })}
          </Text>
        </View>
        <View className="flex-row items-center gap-2">
          <InlineStarRating
            currentRating={currentRating}
            onStarClick={handleStarClick}
            disabled={submittedFeedback !== null || isSubmittingFeedback}
          />
        </View>
      </View>

      {/* Follow-up Prompts - Using shared PromptExamples component */}
      {followUpPrompts && followUpPrompts.length > 0 && (
        <PromptExamples
          prompts={followUpPrompts}
          onPromptClick={onFollowUpClick}
          title={samplePromptsTitle || t('chat.suggestedFollowUps', { defaultValue: 'Sample prompts' })}
          showTitle={true}
          maxPrompts={4}
        />
      )}
    </View>
  );
}
