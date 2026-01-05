import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import * as React from 'react';
import { View, Pressable, ScrollView, Image } from 'react-native';
import { IMAGE_STYLES, SLIDES_TEMPLATES, DOCUMENT_TYPES, DATA_TYPES } from './quickActionViews';
import * as Haptics from 'expo-haptics';
import { Check } from 'lucide-react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, withSpring } from 'react-native-reanimated';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface LibraryTemplateSelectorProps {
  actionId: string;
  selectedTemplateId?: string | null;
  onSelectTemplate?: (templateId: string) => void;
  onSelectPrompt?: (prompt: string) => void;
}

/**
 * LibraryTemplateSelector Component
 * 
 * Always shows template options for modes that have templates (slides, docs, image, data).
 * Templates are always visible when a mode is selected, with selected state indicated.
 */
export function LibraryTemplateSelector({
  actionId,
  selectedTemplateId,
  onSelectTemplate,
  onSelectPrompt,
}: LibraryTemplateSelectorProps) {
  
  // Get templates based on action mode
  const templates = React.useMemo(() => {
    switch (actionId) {
      case 'image':
        return IMAGE_STYLES;
      case 'slides':
        return SLIDES_TEMPLATES;
      case 'docs':
        return DOCUMENT_TYPES;
      case 'data':
        return DATA_TYPES;
      default:
        return [];
    }
  }, [actionId]);

  // Short, mode-specific prompts
  const prompts = React.useMemo(() => {
    if (actionId === 'research') {
      return [
        'AI trends 2024',
        'Competitor analysis',
        'Market research',
        'Industry insights',
        'Tech news',
        'Data analysis',
        'Trends report',
        'Market size',
        'Industry report',
        'Research summary',
      ];
    }
    if (actionId === 'people') {
      return [
        'Find engineers',
        'Hire developers',
        'Find CTOs',
        'Sales candidates',
        'Marketing leads',
        'Product managers',
        'Designers',
        'Data scientists',
        'Find experts',
        'Team members',
      ];
    }
    return [];
  }, [actionId]);

  const handleTemplateSelect = React.useCallback((templateId: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    // Toggle selection: if already selected, deselect; otherwise select
    if (selectedTemplateId === templateId) {
      onSelectTemplate?.(null as any);
    } else {
      onSelectTemplate?.(templateId);
    }
  }, [onSelectTemplate, selectedTemplateId]);

  const handlePromptSelect = React.useCallback((prompt: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onSelectPrompt?.(prompt);
  }, [onSelectPrompt]);

  // Show prompts for research and people modes
  if (actionId === 'research' || actionId === 'people') {
    if (prompts.length === 0) {
      return null;
    }

    return (
      <View className="mb-3" style={{ overflow: 'visible' }}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ 
            gap: 12,
            paddingHorizontal: 16,
          }}
          style={{ overflow: 'visible' }}
        >
          {prompts.map((prompt, index) => (
            <PromptCard
              key={`${prompt}-${index}`}
              prompt={prompt}
              onPress={() => handlePromptSelect(prompt)}
            />
          ))}
        </ScrollView>
      </View>
    );
  }

  // Hide if no templates available
  if (templates.length === 0) {
    return null;
  }

  // Always show horizontal scrollable template options
  return (
    <View className="mb-3" style={{ overflow: 'visible' }}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ 
          gap: 12,
          paddingHorizontal: 16,
        }}
        style={{ overflow: 'visible' }}
      >
        {templates.map((template) => {
          return (
            <TemplateCard
              key={template.id}
              template={template}
              actionId={actionId}
              isSelected={selectedTemplateId === template.id}
              onPress={() => handleTemplateSelect(template.id)}
            />
          );
        })}
      </ScrollView>
    </View>
  );
}

interface TemplateCardProps {
  template: {
    id: string;
    label: string;
    icon?: any;
    imageUrl?: any;
  };
  actionId: string;
  isSelected: boolean;
  onPress: () => void;
}

function TemplateCard({ template, actionId, isSelected, onPress }: TemplateCardProps) {
  const checkmarkScale = useSharedValue(isSelected ? 1 : 0);
  const borderOpacity = useSharedValue(isSelected ? 1 : 0);
  const overlayOpacity = useSharedValue(isSelected ? 1 : 0);

  // Update animations when selection changes
  React.useEffect(() => {
    if (isSelected) {
      checkmarkScale.value = withTiming(1, { duration: 200 });
      borderOpacity.value = withTiming(1, { duration: 200 });
      overlayOpacity.value = withTiming(1, { duration: 200 });
    } else {
      checkmarkScale.value = withTiming(0, { duration: 150 });
      borderOpacity.value = withTiming(0, { duration: 150 });
      overlayOpacity.value = withTiming(0, { duration: 150 });
    }
  }, [isSelected, checkmarkScale, borderOpacity, overlayOpacity]);

  const checkmarkStyle = useAnimatedStyle(() => ({
    transform: [{ scale: checkmarkScale.value }],
    opacity: checkmarkScale.value,
  }), [checkmarkScale]);

  const borderStyle = useAnimatedStyle(() => ({
    opacity: borderOpacity.value,
  }), [borderOpacity]);

  const overlayStyle = useAnimatedStyle(() => ({
    opacity: overlayOpacity.value,
  }), [overlayOpacity]);

  // Use 16:9 aspect ratio for slides (142px width), square (80px) for others
  const containerWidth = actionId === 'slides' ? 142 : 80;
  const containerHeight = 80;

  return (
    <Pressable
      onPress={onPress}
      className="items-center"
      style={{ width: containerWidth }}
    >
      {/* Template Image or Icon */}
      <View 
        className={`rounded-xl overflow-hidden mb-2 items-center justify-center relative ${
          isSelected ? 'bg-primary/10' : 'bg-muted'
        }`}
        style={{ width: containerWidth, height: containerHeight }}
      >
        {template.imageUrl ? (
          <Image
            source={template.imageUrl}
            style={{ width: '100%', height: '100%' }}
            resizeMode="cover"
          />
        ) : template.icon ? (
          <Icon
            as={template.icon}
            size={32}
            className="text-foreground opacity-70"
          />
        ) : null}

        {/* Subtle selection overlay */}
        {isSelected && (
          <Animated.View 
            style={overlayStyle}
            className="absolute inset-0 bg-primary/10 pointer-events-none"
          />
        )}

        {/* Subtle border highlight */}
        {isSelected && (
          <Animated.View 
            style={borderStyle}
            className="absolute inset-0 border-2 border-primary rounded-xl pointer-events-none"
          />
        )}

        {/* Checkmark badge */}
        {isSelected && (
          <Animated.View 
            style={checkmarkStyle}
            className="absolute top-1.5 right-1.5 bg-primary rounded-full p-1 shadow-lg"
          >
            <Icon 
              as={Check} 
              size={12} 
              className="text-primary-foreground"
              strokeWidth={3}
            />
          </Animated.View>
        )}
      </View>

      {/* Template Name */}
      <Text
        className={`text-xs font-roobert-medium text-center ${
          isSelected ? 'text-primary' : 'text-foreground'
        }`}
        numberOfLines={2}
      >
        {template.label}
      </Text>
    </Pressable>
  );
}

interface PromptCardProps {
  prompt: string;
  onPress: () => void;
}

function PromptCard({ prompt, onPress }: PromptCardProps) {
  const scale = useSharedValue(1);
  
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }), [scale]);

  const handlePressIn = () => {
    scale.value = withSpring(0.98, { damping: 15, stiffness: 400 });
  };

  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 });
  };

  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={animatedStyle}
      className="border border-border dark:border-border/80 rounded-full h-12 px-4 flex flex-row items-center justify-center active:opacity-80"
    >
      <Text 
        className="text-base font-medium text-foreground"
        numberOfLines={1}
        ellipsizeMode="tail"
      >
        {prompt}
      </Text>
    </AnimatedPressable>
  );
}

