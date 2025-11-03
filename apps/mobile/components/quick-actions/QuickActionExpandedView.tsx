import { Text } from '@/components/ui/text';
import * as React from 'react';
import { ScrollView, View, Pressable } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { QuickActionOptionCard } from './QuickActionOptionCard';
import { getQuickActionOptions } from './quickActionViews';
import { useLanguage } from '@/contexts';
import { getRandomPrompts } from './starterPrompts';
import { Icon } from '@/components/ui/icon';
import { ArrowUpRight, RefreshCw } from 'lucide-react-native';
import { TemplatePreviewModal } from './TemplatePreviewModal';

interface QuickActionExpandedViewProps {
  actionId: string;
  actionLabel: string;
  onBack: () => void;
  onSelectOption: (optionId: string) => void;
  selectedOptionId?: string | null;
  onSelectPrompt?: (prompt: string) => void;
}

/**
 * QuickActionExpandedView Component
 * 
 * Replaces the quick action bar when an action is selected.
 * Shows custom options specific to the selected action.
 * For slides: displays templates in 16:9 aspect ratio for better preview.
 * For people & research: shows example prompts for inspiration.
 */
export function QuickActionExpandedView({ 
  actionId, 
  actionLabel,
  onBack,
  onSelectOption,
  selectedOptionId,
  onSelectPrompt
}: QuickActionExpandedViewProps) {
  const { t } = useLanguage();
  const options = getQuickActionOptions(actionId);
  
  // Slides mode gets special treatment with better spacing
  const isSlideMode = actionId === 'slides';
  const showPromptExamples = actionId === 'people' || actionId === 'research';
  
  // State for prompt examples
  const [prompts, setPrompts] = React.useState<string[]>([]);
  
  // State for template preview
  const [previewTemplate, setPreviewTemplate] = React.useState<{ id: string; name: string } | null>(null);
  const [isPreviewVisible, setIsPreviewVisible] = React.useState(false);
  
  // Load random prompts on mount and when actionId changes
  React.useEffect(() => {
    if (showPromptExamples) {
      setPrompts(getRandomPrompts(actionId, 3));
    }
  }, [actionId, showPromptExamples]);
  
  const refreshPrompts = () => {
    setPrompts(getRandomPrompts(actionId, 3));
  };
  
  const handlePreview = (templateId: string, templateName: string) => {
    console.log('👁️ Opening template preview:', templateName);
    setPreviewTemplate({ id: templateId, name: templateName });
    setIsPreviewVisible(true);
  };
  
  const handleClosePreview = () => {
    console.log('👁️ Closing template preview');
    setIsPreviewVisible(false);
  };
  
  // Use "template" for slides, "style" for everything else
  const headerText = isSlideMode 
    ? t('quickActions.chooseTemplate', { defaultValue: 'Choose template' })
    : t('quickActions.chooseStyle', { action: actionLabel });

  return (
    <Animated.View 
      entering={FadeIn.duration(200)}
      exiting={FadeOut.duration(200)}
      className="mb-4"
    >
      {/* Header - only show for modes with visual options */}
      {!showPromptExamples && (
        <View className="flex-row items-center justify-between mb-3 px-6">
          <Text className="text-sm font-roobert-medium text-foreground">
            {headerText}
          </Text>
          {selectedOptionId && (
            <View className="bg-primary/10 px-2 py-1 rounded-full">
              <Text className="text-xs font-roobert-medium text-primary">
                {t('quickActions.selected', { defaultValue: 'Selected' })}
              </Text>
            </View>
          )}
        </View>
      )}

      {/* Prompt Examples for People & Research */}
      {showPromptExamples ? (
        <View className="px-6 gap-3">
          <View className="flex-row items-center justify-between mb-1">
            <Text className="text-xs font-roobert-medium text-muted-foreground uppercase tracking-wide">
              {t('quickActions.examplePrompts', { defaultValue: 'Example Prompts' })}
            </Text>
            <Pressable onPress={refreshPrompts} className="p-1.5">
              <Icon as={RefreshCw} size={14} className="text-muted-foreground" />
            </Pressable>
          </View>
          
          {prompts.map((prompt, index) => (
            <Pressable
              key={`${prompt}-${index}`}
              onPress={() => {
                console.log('📝 Example prompt selected:', prompt);
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
            paddingHorizontal: 24,
            paddingVertical: isSlideMode ? 8 : 0
          }}
          className="flex-row"
        >
        {options.map((option, index) => (
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

