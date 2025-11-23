import * as React from 'react';
import { View, Pressable, ActivityIndicator, Alert } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import {
  ArrowLeft,
  CheckCircle2,
  Search,
  AlertCircle
} from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { useLanguage } from '@/contexts';
import {
  useComposioTools,
  useUpdateComposioTools,
  type ComposioApp,
  type ComposioProfile,
  type ComposioTool
} from '@/hooks/useComposio';
import { ToolkitIcon } from './ToolkitIcon';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring
} from 'react-native-reanimated';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface ComposioToolsContentProps {
  app: ComposioApp;
  profile: ComposioProfile;
  agentId: string;
  onBack?: () => void;
  onComplete: () => void;
  noPadding?: boolean;
}

export function ComposioToolsContent({
  app,
  profile,
  agentId,
  onBack,
  onComplete,
  noPadding = false
}: ComposioToolsContentProps) {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const { data: toolsData, isLoading, error, refetch } = useComposioTools(profile.profile_id);
  const { mutate: updateTools, isPending: isSaving } = useUpdateComposioTools();

  const [selectedTools, setSelectedTools] = React.useState<Set<string>>(new Set());

  const tools = toolsData?.tools || [];

  const handleToolToggle = React.useCallback((toolName: string) => {
    setSelectedTools(prev => {
      const newSet = new Set(prev);
      if (newSet.has(toolName)) {
        newSet.delete(toolName);
      } else {
        newSet.add(toolName);
      }
      return newSet;
    });
  }, []);

  const handleSelectAll = React.useCallback(() => {
    if (selectedTools.size === tools.length) {
      setSelectedTools(new Set());
    } else {
      setSelectedTools(new Set(tools.map((tool: ComposioTool) => tool.name)));
    }
  }, [tools, selectedTools.size]);

  const handleSaveTools = React.useCallback(() => {
    if (!agentId) return;

    updateTools({
      agentId,
      profileId: profile.profile_id,
      selectedTools: Array.from(selectedTools)
    }, {
      onSuccess: (data) => {
        console.log('✅ Tools saved successfully:', data);
        Alert.alert(t('integrations.connectionSuccess'), t('integrations.toolsSelector.toolsAddedSuccess', { count: selectedTools.size, app: app.name }));
        onComplete();
      },
      onError: (error: any) => {
        console.error('❌ Failed to save tools:', error);
        Alert.alert(t('integrations.connectionError'), error.message || t('integrations.toolsSelector.failedToSaveTools'));
      }
    });
  }, [agentId, profile.profile_id, selectedTools, updateTools, app.name, onComplete, t]);

  return (
    <View className={noPadding ? "pb-6" : "pb-6"}>
      {/* Header with back button, title, and description */}
      <View className="flex-row items-center mb-4">
        {onBack && (
          <Pressable
            onPress={onBack}
            className="flex-row items-center active:opacity-70"
          >
            <ArrowLeft
              size={20}
              color={colorScheme === 'dark' ? '#f8f8f8' : '#121215'}
            />
          </Pressable>
        )}
        <View className="flex-1 ml-3">
          <Text
            style={{ color: colorScheme === 'dark' ? '#f8f8f8' : '#121215' }}
            className="text-xl font-roobert-semibold"
          >
            {app.name}
          </Text>
          <Text
            style={{ color: colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.6)' : 'rgba(18, 18, 21, 0.6)' }}
            className="text-sm font-roobert"
          >
            {profile.profile_name}
          </Text>
        </View>
      </View>

      <View className={noPadding ? "" : "px-0"}>

        <View className="flex-row items-center justify-between mb-6">
          <Text className="text-sm font-roobert-medium text-muted-foreground uppercase tracking-wider">
            {t('integrations.toolsSelector.selected', { count: selectedTools.size, total: tools.length, plural: selectedTools.size !== 1 ? 's' : '' })}
          </Text>
          <Pressable
            onPress={handleSelectAll}
            className="px-4 py-2 rounded-full bg-muted/10 active:opacity-70"
          >
            <Text className="text-sm font-roobert-semibold text-foreground">
              {selectedTools.size === tools.length ? t('integrations.toolsSelector.deselectAll') : t('integrations.toolsSelector.selectAll')}
            </Text>
          </Pressable>
        </View>
        {isLoading ? (
          <View className="items-center py-8">
            <ActivityIndicator size="large" className="text-primary" />
            <Text className="text-sm font-roobert text-muted-foreground mt-2">
              {t('integrations.toolsSelector.loadingTools')}
            </Text>
          </View>
        ) : error ? (
          <View className="items-center py-8">
            <Icon as={AlertCircle} size={48} className="text-destructive/40" />
            <Text className="text-lg font-roobert-medium text-foreground mt-4">
              Failed to Load Tools
            </Text>
            <Text className="text-sm font-roobert text-muted-foreground text-center mt-2">
              {error.message}
            </Text>
            <Pressable
              onPress={() => refetch()}
              className="mt-4 px-4 py-2 bg-primary rounded-xl"
            >
              <Text className="text-sm font-roobert-medium text-white">
                Retry
              </Text>
            </Pressable>
          </View>
        ) : (
          <View className="space-y-3 mb-6">
            {tools.length > 0 ? (
              tools.map((tool: ComposioTool, index: number) => (
                <ToolCard
                  key={tool.name || index}
                  tool={tool}
                  selected={selectedTools.has(tool.name)}
                  onToggle={() => handleToolToggle(tool.name)}
                />
              ))
            ) : (
              <View className="items-center py-12 px-6">
                <Icon as={Search} size={48} className="text-muted-foreground/40" />
                <Text className="text-lg font-roobert-medium text-foreground mt-4">
                  {t('integrations.toolsSelector.noToolsAvailable')}
                </Text>
                <Text className="text-sm font-roobert text-muted-foreground text-center">
                  {t('integrations.toolsSelector.noToolsDescription')}
                </Text>
              </View>
            )}
          </View>
        )}

        <ContinueButton
          onPress={handleSaveTools}
          disabled={selectedTools.size === 0 || isSaving}
          isLoading={isSaving}
          label={isSaving ? t('integrations.toolsSelector.addingTools') : selectedTools.size === 0 ? t('integrations.toolsSelector.selectTools') : selectedTools.size === 1 ? t('integrations.toolsSelector.addTool', { count: selectedTools.size }) : t('integrations.toolsSelector.addTools', { count: selectedTools.size })}
          rounded="full"
        />
      </View>
    </View>
  );
}

interface ToolCardProps {
  tool: ComposioTool;
  selected: boolean;
  onToggle: () => void;
}

interface ContinueButtonProps {
  onPress: () => void;
  disabled?: boolean;
  label: string;
  isLoading?: boolean;
  rounded?: 'full' | '2xl';
}

const ContinueButton = React.memo(({
  onPress,
  disabled = false,
  label,
  isLoading = false,
  rounded = 'full'
}: ContinueButtonProps) => {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = React.useCallback(() => {
    if (!disabled) {
      scale.value = withSpring(0.97, { damping: 15, stiffness: 400 });
    }
  }, [scale, disabled]);

  const handlePressOut = React.useCallback(() => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 });
  }, [scale]);

  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={animatedStyle}
      disabled={disabled}
      className={`w-full py-4 items-center ${rounded === 'full' ? 'rounded-full' : 'rounded-2xl'} ${disabled ? 'bg-muted/20' : 'bg-foreground'
        }`}
    >
      <View className="flex-row items-center gap-2">
        {isLoading && <ActivityIndicator size="small" color="#fff" />}
        <Text className={`text-base font-roobert-semibold ${disabled ? 'text-muted-foreground' : 'text-background'
          }`}>
          {label}
        </Text>
      </View>
    </AnimatedPressable>
  );
});

const ToolCard = React.memo(({ tool, selected, onToggle }: ToolCardProps) => {
  return (
    <Pressable
      onPress={onToggle}
      className={`flex-row items-start gap-3 p-4 rounded-3xl mb-2 active:opacity-80 ${selected
          ? 'bg-primary/10'
          : 'bg-muted/5'
        }`}
    >
      <View className={`w-6 h-6 rounded-full items-center justify-center mt-0.5 ${selected ? 'bg-primary' : 'bg-transparent border-2 border-muted-foreground/30'
        }`}>
        {selected && (
          <Icon
            as={CheckCircle2}
            size={16}
            className="text-primary-foreground"
            strokeWidth={2.5}
          />
        )}
      </View>

      <View className="flex-1">
        <Text className="font-roobert-semibold text-foreground mb-1">
          {tool.name}
        </Text>
        <Text
          className="text-sm font-roobert text-muted-foreground leading-relaxed"
          numberOfLines={2}
          ellipsizeMode="tail"
        >
          {tool.description}
        </Text>
      </View>
    </Pressable>
  );
});
