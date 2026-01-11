import { Text } from '@/components/ui/text';
import * as React from 'react';
import { ScrollView, View, Pressable, LayoutAnimation, Platform, UIManager } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { QuickActionOptionCard } from './QuickActionOptionCard';
import { getQuickActionOptions } from './quickActionViews';
import { useLanguage } from '@/contexts';
import { getRandomPrompts } from './starterPrompts';
import { Icon } from '@/components/ui/icon';
import { ArrowUpRight, RefreshCw, MessageCircle, ChevronDown, ChevronUp } from 'lucide-react-native';
import { TemplatePreviewModal } from './TemplatePreviewModal';
import { useThreads } from '@/lib/chat/hooks';
import type { Thread } from '@/api/types';
import { log } from '@/lib/logger';

// Enable LayoutAnimation on Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

interface QuickActionExpandedViewProps {
  actionId: string;
  actionLabel: string;
  onSelectOption: (optionId: string) => void;
  selectedOptionId?: string | null;
  onSelectPrompt?: (prompt: string) => void;
  onThreadPress?: (threadId: string) => void;
}

/**
 * QuickActionExpandedView Component
 * 
 * Displays options/templates for the selected quick action mode.
 * Shown above the chat input when a mode is selected.
 * For slides: displays templates in 16:9 aspect ratio for better preview.
 * For people & research: shows example prompts for inspiration.
 */
export function QuickActionExpandedView({ 
  actionId, 
  actionLabel,
  onSelectOption,
  selectedOptionId,
  onSelectPrompt,
  onThreadPress
}: QuickActionExpandedViewProps) {
  const { t } = useLanguage();
  const options = getQuickActionOptions(actionId);
  
  // Slides mode gets special treatment with better spacing
  const isSlideMode = actionId === 'slides';
  const showPromptExamples = actionId === 'people' || actionId === 'research';
  
  // Collapsible state - expanded by default
  const [isExpanded, setIsExpanded] = React.useState(true);
  
  // Fetch threads and filter by mode
  const { data: allThreads = [] } = useThreads();
  
  // Filter threads that match the current mode
  const modeThreads = React.useMemo(() => {
    return allThreads
      .filter((thread: Thread) => thread.metadata?.mode === actionId)
      .slice(0, 5); // Limit to 5 most recent
  }, [allThreads, actionId]);
  
  // State for prompt examples
  const [prompts, setPrompts] = React.useState<string[]>([]);
  
  // State for template preview
  const [previewTemplate, setPreviewTemplate] = React.useState<{ id: string; name: string } | null>(null);
  const [isPreviewVisible, setIsPreviewVisible] = React.useState(false);
  
  // Load random prompts on mount and when actionId changes
  React.useEffect(() => {
    if (showPromptExamples) {
      setPrompts(getRandomPrompts(actionId, 3, t));
    }
  }, [actionId, showPromptExamples, t]);
  
  // Toggle expansion with animation
  const toggleExpanded = React.useCallback(() => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setIsExpanded(prev => !prev);
  }, []);
  
  const refreshPrompts = () => {
    setPrompts(getRandomPrompts(actionId, 3, t));
  };
  
  const handlePreview = (templateId: string, templateName: string) => {
    log.log('👁️ Opening template preview:', templateName);
    setPreviewTemplate({ id: templateId, name: templateName });
    setIsPreviewVisible(true);
  };
  
  const handleClosePreview = () => {
    log.log('👁️ Closing template preview');
    setIsPreviewVisible(false);
  };
  
  // Use "template" for slides, "style" for everything else
  const headerText = isSlideMode 
    ? t('quickActions.chooseTemplate', { defaultValue: 'Choose template' })
    : t('quickActions.chooseStyle', { action: actionLabel });
  
  // Collapsible header text
  const collapsibleHeaderText = showPromptExamples
    ? t('quickActions.examplePrompts', { defaultValue: 'Example Prompts' })
    : headerText;

  return (
    <Animated.View 
      entering={FadeIn.duration(200)}
      exiting={FadeOut.duration(200)}
    >
      {/* Recent Threads for this mode - Always visible */}
      {modeThreads.length > 0 && (
        <View className="mb-4">
          <View className="flex-row items-center justify-between mb-2 px-3">
            <Text className="text-xs font-roobert-medium text-muted-foreground uppercase tracking-wide">
              {t('quickActions.recent', { defaultValue: 'Recent' })}
            </Text>
          </View>
          <ScrollView 
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ 
              paddingHorizontal: 12,
              gap: 8
            }}
          >
            {modeThreads.map((thread: Thread) => (
              <Pressable
                key={thread.thread_id}
                onPress={() => {
                  log.log('📂 Opening thread from mode history:', thread.thread_id);
                  onThreadPress?.(thread.thread_id);
                }}
                className="bg-card border border-border/50 rounded-xl px-3 py-2.5 active:bg-accent/50 flex-row items-center gap-2"
                style={{ maxWidth: 200 }}
              >
                <Icon as={MessageCircle} size={14} className="text-muted-foreground flex-shrink-0" />
                <Text 
                  className="text-sm text-foreground/80 flex-1" 
                  numberOfLines={1}
                  ellipsizeMode="tail"
                >
                  {thread.project?.name || thread.title || t('common.untitledChat', { defaultValue: 'Untitled Chat' })}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Collapsible Header - Tap to expand/collapse templates/styles */}
      <Pressable 
        onPress={toggleExpanded}
        className={`flex-row items-center justify-between px-3 py-1 active:opacity-70 ${isExpanded ? 'mb-3' : ''}`}
      >
        <View className="flex-row items-center gap-2">
          <Text className="text-sm font-roobert-medium text-foreground">
            {collapsibleHeaderText}
          </Text>
          {selectedOptionId && !isExpanded && (
            <View className="bg-primary/10 px-2 py-0.5 rounded-full">
              <Text className="text-xs font-roobert-medium text-primary">
                {t('quickActions.selected', { defaultValue: 'Selected' })}
              </Text>
            </View>
          )}
        </View>
        <Icon 
          as={isExpanded ? ChevronUp : ChevronDown} 
          size={18} 
          className="text-muted-foreground" 
        />
      </Pressable>

      {/* Collapsible Content - Templates/Styles/Prompts */}
      {isExpanded && (
        <>
          {/* Prompt Examples for People & Research */}
          {showPromptExamples ? (
            <View className="px-3 gap-3">
              <View className="flex-row items-center justify-end mb-1">
                <Pressable onPress={refreshPrompts} className="p-1.5">
                  <Icon as={RefreshCw} size={14} className="text-muted-foreground" />
                </Pressable>
              </View>
              
              {prompts.map((prompt, index) => (
                <Pressable
                  key={`${prompt}-${index}`}
                  onPress={() => {
                    log.log('📝 Example prompt selected:', prompt);
                    onSelectPrompt?.(prompt);
                  }}
                  className="bg-card border border-border/50 rounded-xl p-4 active:bg-accent/50"
                >
                  <View className="flex-row items-start justify-between gap-3">
                    <Text className="text-sm text-foreground/80 flex-1 leading-5">
                      {prompt}
                    </Text>
                    <Icon as={ArrowUpRight} size={16} className="text-muted-foreground mt-0.5 flex-shrink-0" />
                  </View>
                </Pressable>
              ))}
            </View>
          ) : (
            /* Options Grid for visual modes */
            <ScrollView 
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ 
                paddingHorizontal: 12,
                paddingVertical: isSlideMode ? 8 : 0,
                gap: 16
              }}
              className="flex-row"
            >
              {options.map((option) => (
                <QuickActionOptionCard 
                  key={option.id} 
                  option={option}
                  actionId={actionId}
                  onPress={onSelectOption}
                  isSelected={selectedOptionId === option.id}
                  onPreview={isSlideMode ? handlePreview : undefined}
                />
              ))}
            </ScrollView>
          )}
        </>
      )}
    
      {/* Template Preview Modal */}
      {previewTemplate && (
        <TemplatePreviewModal
          visible={isPreviewVisible}
          onClose={handleClosePreview}
          templateId={previewTemplate.id}
          templateName={previewTemplate.name}
        />
      )}
    </Animated.View>
  );
}

