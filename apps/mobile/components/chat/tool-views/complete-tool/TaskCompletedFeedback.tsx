import React, { useState, useCallback, useEffect } from 'react';
import { View, Pressable, TextInput, ScrollView, Alert } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { CheckCircle2, Star, MessageSquare, FileText, Layers, ChevronRight } from 'lucide-react-native';
import BottomSheet, { BottomSheetBackdrop, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Button } from '@/components/ui/button';
import { CheckCircle2 as CheckIcon } from 'lucide-react-native';
import { API_URL, getAuthHeaders } from '@/api/config';

interface FollowUpPrompt {
  icon: React.ComponentType<any>;
  text: string;
  action?: () => void;
}

interface MessageFeedback {
  feedback_id: string;
  thread_id?: string;
  message_id?: string;
  account_id: string;
  rating: number;
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
  threadId?: string;
  messageId?: string | null;
}

export function TaskCompletedFeedback({ 
  taskSummary,
  followUpPrompts,
  onFollowUpClick,
  threadId,
  messageId
}: TaskCompletedFeedbackProps) {
  const { colorScheme } = useColorScheme();
  const insets = useSafeAreaInsets();
  const [rating, setRating] = useState<number | null>(null);
  const [feedback, setFeedback] = useState('');
  const [helpImprove, setHelpImprove] = useState(true);
  const [showRatingModal, setShowRatingModal] = useState(false);
  const [submittedFeedback, setSubmittedFeedback] = useState<MessageFeedback | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoadingFeedback, setIsLoadingFeedback] = useState(false);
  const bottomSheetRef = React.useRef<BottomSheet>(null);
  const snapPoints = React.useMemo(() => ['75%'], []);

  // Fetch existing feedback on mount
  useEffect(() => {
    if (threadId && messageId) {
      setIsLoadingFeedback(true);
      fetchFeedback();
    }
  }, [threadId, messageId]);

  const fetchFeedback = async () => {
    try {
      const headers = await getAuthHeaders();
      const params = new URLSearchParams();
      if (threadId) params.append('thread_id', threadId);
      if (messageId) params.append('message_id', messageId);
      
      const response = await fetch(`${API_URL}/feedback?${params.toString()}`, {
        method: 'GET',
        headers,
      });

      if (response.ok) {
        const data: MessageFeedback[] = await response.json();
        if (data && data.length > 0) {
          const feedbackData = data[0];
          setSubmittedFeedback(feedbackData);
          setRating(feedbackData.rating);
          setFeedback(feedbackData.feedback_text || '');
          setHelpImprove(feedbackData.help_improve);
        }
      }
    } catch (error) {
      console.error('Error fetching feedback:', error);
    } finally {
      setIsLoadingFeedback(false);
    }
  };

  React.useEffect(() => {
    if (showRatingModal) {
      bottomSheetRef.current?.snapToIndex(0);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } else {
      bottomSheetRef.current?.close();
    }
  }, [showRatingModal]);

  // Only use prompts provided from the tool - no fallback generation
  const promptsToDisplay: FollowUpPrompt[] = followUpPrompts && followUpPrompts.length > 0
    ? followUpPrompts.slice(0, 4).map(text => ({
        icon: MessageSquare,
        text,
      }))
    : [];

  const handleStarClick = (value: number) => {
    setRating(value);
    setShowRatingModal(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleSubmitRating = async () => {
    if (!rating || !threadId || !messageId) return;

    setIsSubmitting(true);
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(`${API_URL}/feedback`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          rating,
          feedback_text: feedback.trim() || null,
          help_improve: helpImprove,
          thread_id: threadId,
          message_id: messageId
        }),
      });

      if (response.ok) {
        const data: MessageFeedback = await response.json();
        setSubmittedFeedback(data);
        setShowRatingModal(false);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } else {
        const error = await response.json().catch(() => ({ message: response.statusText }));
        Alert.alert('Error', error.detail?.message || error.message || 'Failed to submit feedback');
      }
    } catch (error) {
      console.error('Error submitting feedback:', error);
      Alert.alert('Error', 'Failed to submit feedback. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={0.5}
      />
    ),
    []
  );

  return (
    <>
      <View className="space-y-4 mt-4">
        {/* Rating Section */}
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center gap-2">
            <Icon as={CheckCircle2} size={16} className="text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
            <Text className="text-sm font-roobert text-muted-foreground">Task completed</Text>
          </View>
          <View className="flex-row items-center gap-2">
            {!submittedFeedback && (
              <Text className="text-sm font-roobert text-muted-foreground">How was this result?</Text>
            )}
            <View className="flex-row items-center gap-1">
              {[1, 2, 3, 4, 5].map((value) => {
                const currentRating = submittedFeedback?.rating ?? rating;
                const isFilled = currentRating !== null && currentRating >= value;
                
                return (
                  <Pressable
                    key={value}
                    onPress={() => handleStarClick(value)}
                    disabled={submittedFeedback !== null}
                    className="active:opacity-70"
                  >
                    <Icon
                      as={Star}
                      size={16}
                      className={isFilled ? 'text-yellow-500 fill-current' : 'text-muted-foreground/30'}
                    />
                  </Pressable>
                );
              })}
            </View>
          </View>
        </View>

        {/* Follow-up Prompts */}
        {promptsToDisplay.length > 0 && (
          <View className="space-y-2">
            <Text className="text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
              Suggested follow-ups
            </Text>
            <View className="space-y-1">
              {promptsToDisplay.map((prompt, index) => {
                const IconComponent = prompt.icon;
                return (
                  <Pressable
                    key={index}
                    onPress={() => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      onFollowUpClick?.(prompt.text);
                    }}
                    className="w-full flex-row items-center gap-3 p-2.5 rounded-xl border border-border bg-card active:bg-muted/50"
                  >
                    <Icon as={IconComponent} size={16} className="text-muted-foreground flex-shrink-0" />
                    <Text className="text-sm font-roobert text-foreground flex-1">
                      {prompt.text}
                    </Text>
                    <Icon as={ChevronRight} size={16} className="text-muted-foreground flex-shrink-0" />
                  </Pressable>
                );
              })}
            </View>
          </View>
        )}
      </View>

      {/* Rating Modal */}
      <BottomSheet
        ref={bottomSheetRef}
        index={-1}
        snapPoints={snapPoints}
        enablePanDownToClose
        onChange={(index) => {
          if (index === -1) {
            setShowRatingModal(false);
          }
        }}
        backdropComponent={renderBackdrop}
        backgroundStyle={{ 
          backgroundColor: colorScheme === 'dark' ? '#161618' : '#FFFFFF'
        }}
        handleIndicatorStyle={{ 
          backgroundColor: colorScheme === 'dark' ? '#3F3F46' : '#D4D4D8',
          width: 36,
          height: 5,
          borderRadius: 3,
        }}
        style={{
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
        }}
      >
        <BottomSheetScrollView 
          className="flex-1"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 20) }}
        >
          <View className="px-6 pt-4 pb-6 space-y-6">
            <View>
              <Text className="text-xl font-roobert-semibold text-foreground mb-1">
                How was this result?
              </Text>
              <Text className="text-sm font-roobert text-muted-foreground">
                Your feedback helps us improve
              </Text>
            </View>

            {/* Star Rating */}
            <View className="flex-row items-center justify-center gap-3">
              {[1, 2, 3, 4, 5].map((value) => (
                <Pressable
                  key={value}
                  onPress={() => {
                    setRating(value);
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  }}
                  className="active:opacity-70"
                >
                  <Icon
                    as={Star}
                    size={32}
                    className={rating && rating >= value ? 'text-yellow-500 fill-current' : 'text-muted-foreground/30'}
                  />
                </Pressable>
              ))}
            </View>

            {/* Feedback Textarea */}
            <View className="space-y-2">
              <TextInput
                placeholder="Additional feedback (optional)"
                placeholderTextColor={colorScheme === 'dark' ? '#71717A' : '#A1A1AA'}
                value={feedback}
                onChangeText={setFeedback}
                multiline
                numberOfLines={4}
                className="min-h-[100px] rounded-xl border border-border bg-muted/30 dark:bg-muted/20 px-4 py-3 text-foreground font-roobert text-sm"
                style={{
                  textAlignVertical: 'top',
                  color: colorScheme === 'dark' ? '#FAFAFA' : '#18181B',
                }}
              />
            </View>

            {/* Help Improve Checkbox */}
            <Pressable
              onPress={() => {
                setHelpImprove(!helpImprove);
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              }}
              className="flex-row items-center gap-3"
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
                Help Kortix improve with my feedback
              </Text>
            </Pressable>

            {/* Action Buttons */}
            <View className="flex-row gap-3 pt-2">
              <Button
                variant="outline"
                onPress={() => {
                  setShowRatingModal(false);
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                }}
                disabled={isSubmitting}
                className="flex-1"
              >
                Cancel
              </Button>
              <Button
                onPress={handleSubmitRating}
                disabled={!rating || isSubmitting}
                className="flex-1"
              >
                {isSubmitting ? 'Submitting...' : 'Submit'}
              </Button>
            </View>
          </View>
        </BottomSheetScrollView>
      </BottomSheet>
    </>
  );
}

