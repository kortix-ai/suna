import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import * as React from 'react';
import { View, Pressable, ScrollView, Image } from 'react-native';
import { ChevronDown, X } from 'lucide-react-native';
import { IMAGE_STYLES, SLIDES_TEMPLATES, DOCUMENT_TYPES, DATA_TYPES } from './quickActionViews';
import type { QuickActionOption } from './quickActionViews';
import * as Haptics from 'expo-haptics';

interface LibraryTemplateSelectorProps {
  actionId: string;
  selectedTemplateId?: string | null;
  onSelectTemplate?: (templateId: string) => void;
}

/**
 * Configuration for library button appearance based on quick action
 */
const LIBRARY_BUTTON_CONFIG = {
  slides: {
    text: 'Templates',
  },
  docs: {
    text: 'Styles',
  },
  image: {
    text: 'Styles',
  },
  data: {
    text: 'Styles',
  },
} as const;

/**
 * LibraryTemplateSelector Component
 * 
 * Interactive library button that expands to show template options.
 * - Initial: Shows dynamic button based on quick action (e.g., "Templates", "Prompts", "Styles")
 * - Expanded: Shows dismiss button + horizontal scrollable template options
 * - Selected: Shows selected template button (tap to deselect)
 */
export function LibraryTemplateSelector({
  actionId,
  selectedTemplateId,
  onSelectTemplate,
}: LibraryTemplateSelectorProps) {
  const [isExpanded, setIsExpanded] = React.useState(false);

  // Get button configuration based on action ID
  const buttonConfig = React.useMemo(() => {
    return LIBRARY_BUTTON_CONFIG[actionId as keyof typeof LIBRARY_BUTTON_CONFIG] || {
      text: 'Library',
    };
  }, [actionId]);

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

  const selectedTemplate = React.useMemo(() => {
    if (!selectedTemplateId) return null;
    return templates.find(t => t.id === selectedTemplateId) || null;
  }, [selectedTemplateId, templates]);

  const handleLibraryPress = React.useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsExpanded(true);
  }, []);

  const handleDismiss = React.useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsExpanded(false);
  }, []);

  const handleTemplateSelect = React.useCallback((templateId: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onSelectTemplate?.(templateId);
    setIsExpanded(false);
  }, [onSelectTemplate]);

  const handleDeselectTemplate = React.useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onSelectTemplate?.(null as any);
  }, [onSelectTemplate]);

  // Hide button for research and people modes (after all hooks)
  if (actionId === 'research' || actionId === 'people') {
    return null;
  }

  // If expanded, show dismiss button + horizontal template options
  if (isExpanded) {
    return (
      <View className="px-4 mb-3">
        {/* Dismiss Button */}
        <Pressable
          onPress={handleDismiss}
          className="border-[1.5px] border-black/10 rounded-full flex-row items-center justify-center px-4 h-8 self-center mb-2"
          style={{ opacity: 0.7 }}
        >
          <Icon as={ChevronDown} size={24} className="text-foreground" strokeWidth={2} />
        </Pressable>

        {/* Horizontal Scrollable Template Options */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 12 }}
        >
          {templates.map((template) => {
            // Use 16:9 aspect ratio for slides (142px width), square (80px) for others
            const containerWidth = actionId === 'slides' ? 142 : 80;
            const containerHeight = 80;
            
            return (
              <Pressable
                key={template.id}
                onPress={() => handleTemplateSelect(template.id)}
                className="items-center"
                style={{ width: containerWidth }}
              >
                {/* Template Image or Icon */}
                <View 
                  className="rounded-xl overflow-hidden bg-muted mb-2 items-center justify-center"
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
                </View>

                {/* Template Name */}
                <Text
                  className="text-xs font-roobert-medium text-foreground text-center"
                  numberOfLines={2}
                >
                  {template.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
    );
  }

  // If template is selected, show selected template button
  if (selectedTemplate) {
    return (
      <View className="px-4 mb-3">
        <Pressable
          onPress={handleDeselectTemplate}
          className="border-[1.5px] border-black/10 rounded-full flex-row items-center gap-2 h-10 self-start pl-2 pr-3"
          style={{ opacity: 0.7 }}
        >
          {/* Template Image or Icon (smaller) */}
          {selectedTemplate.imageUrl ? (
            <View className="w-5 h-5 rounded-full overflow-hidden">
              <Image
                source={selectedTemplate.imageUrl}
                style={{ width: '100%', height: '100%' }}
                resizeMode="cover"
              />
            </View>
          ) : selectedTemplate.icon ? (
            <View className="w-5 h-5 items-center justify-center">
              <Icon
                as={selectedTemplate.icon}
                size={16}
                className="text-foreground opacity-70"
              />
            </View>
          ) : null}

          {/* Template Name */}
          <Text className="text-sm font-roobert-medium text-neutral-900 dark:text-neutral-50">
            {selectedTemplate.label}
          </Text>

          {/* Remove Icon */}
          <Icon as={X} size={16} className="text-foreground" strokeWidth={2} />
        </Pressable>
      </View>
    );
  }

  // Default: Show dynamic library button based on quick action
  return (
    <View className="px-4 mb-3">
      <Pressable
        onPress={handleLibraryPress}
        className="border-[1.5px] border-neutral-900/10 dark:border-neutral-50/10 rounded-full flex-row items-center gap-1 px-4 h-10 self-start"
        style={{ opacity: 0.7 }}
      >
        <Text className="text-base font-roobert-medium text-neutral-900 dark:text-neutral-50">{buttonConfig.text}</Text>
      </Pressable>
    </View>
  );
}

