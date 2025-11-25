import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { CheckCircle2, Star, MessageSquare, ChevronRight } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { API_URL, getAuthHeaders } from '@/api/config';
import { useLanguage } from '@/contexts/LanguageContext';
import { useFeedbackDrawerStore } from '@/stores/feedback-drawer-store';

interface FollowUpPrompt {
  icon: React.ComponentType<any>;
  text: string;
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
  const { t } = useLanguage();
  const { openFeedbackDrawer } = useFeedbackDrawerStore();
  
  // State
  const [submittedFeedback, setSubmittedFeedback] = useState<MessageFeedback | null>(null);
  
  // Fetch existing feedback
  useEffect(() => {
    if (!threadId || !messageId) return;
    
    const fetchFeedback = async () => {
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
          }
        }
      } catch (error) {
        console.error('Error fetching feedback:', error);
      }
    };
    
    fetchFeedback();
  }, [threadId, messageId]);

  // Prompts
  const promptsToDisplay: FollowUpPrompt[] = useMemo(() => {
    return followUpPrompts && followUpPrompts.length > 0
      ? followUpPrompts.slice(0, 4).map(text => ({
          icon: MessageSquare,
          text,
        }))
      : [];
  }, [followUpPrompts]);

  const handleStarClick = useCallback((value: number) => {
    console.log('⭐ Star clicked:', value, { submittedFeedback, threadId, messageId });
    if (submittedFeedback) return;
    
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    
    // Small delay to let gesture system settle (important when inside another BottomSheet)
    setTimeout(() => {
      console.log('⭐ Opening feedback drawer with:', { rating: value, threadId, messageId });
      openFeedbackDrawer({
        rating: value,
        threadId,
        messageId: messageId || undefined,
      });
    }, 50);
  }, [submittedFeedback, openFeedbackDrawer, threadId, messageId]);

  const currentRating = submittedFeedback?.rating ?? null;

  return (
    <View className="space-y-4 mt-4">
      {/* Rating Section */}
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center gap-2">
          <Icon as={CheckCircle2} size={16} className="text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
          <Text className="text-sm font-roobert text-muted-foreground">{t('chat.taskCompleted')}</Text>
        </View>
        <View className="flex-row items-center gap-2">
          {!submittedFeedback && (
            <Text className="text-sm font-roobert text-muted-foreground">{t('chat.howWasThisResult')}</Text>
          )}
          <View className="flex-row items-center gap-1">
            {[1, 2, 3, 4, 5].map((value) => {
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
            {t('chat.suggestedFollowUps')}
          </Text>
          <View className="space-y-1">
            {promptsToDisplay.map((prompt, index) => {
              const IconComponent = prompt.icon;
              return (
                <Pressable
                  key={`prompt-${index}-${prompt.text}`}
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    onFollowUpClick?.(prompt.text);
                  }}
                  className="w-full flex-row items-center gap-3 p-2.5 rounded-xl border border-border bg-card active:bg-muted/50"
                >
                  <Icon as={IconComponent as any} size={16} className="text-muted-foreground flex-shrink-0" />
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
  );
}
