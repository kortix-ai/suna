import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import BottomSheet, { BottomSheetBackdrop, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import * as Haptics from 'expo-haptics';
import { ChevronLeft } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { Pressable, View } from 'react-native';
import { AgentAvatar } from '../agents/AgentAvatar';
import type { Agent, Model } from '../shared/types';
import { useLanguage } from '@/contexts';

interface ModelDrawerProps {
  visible: boolean;
  onClose: () => void;
  agent: Agent;
  selectedModelId: string;
  onSelectModel: (model: Model) => void;
}

/**
 * ModelDrawer Component - Nested drawer for model selection
 * Based on Figma design: node-id=375-9639
 * 
 * Features:
 * - Shows models available for the selected agent
 * - Back button to return to agent selection
 * - Model selection with haptic feedback
 * - Proper theming and styling
 */
export function ModelDrawer({ 
  visible, 
  onClose, 
  agent,
  selectedModelId, 
  onSelectModel
}: ModelDrawerProps) {
  const { t } = useLanguage();
  const bottomSheetRef = React.useRef<BottomSheet>(null);
  const snapPoints = React.useMemo(() => ['60%'], []);
  const { colorScheme } = useColorScheme();

  // Handle visibility changes
  React.useEffect(() => {
    if (visible) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      console.log('📳 Haptic Feedback: Model Drawer Opened');
      console.log('🤖 Agent:', agent.name);
      bottomSheetRef.current?.snapToIndex(0);
    } else {
      bottomSheetRef.current?.close();
    }
  }, [visible, agent]);

  const renderBackdrop = React.useCallback(
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

  const handleSheetChange = React.useCallback((index: number) => {
    if (index === -1) {
      onClose();
    }
  }, [onClose]);

  const handleBackPress = React.useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    console.log('🔙 Back to Agent Selection');
    onClose();
  }, [onClose]);

  return (
    <BottomSheet
      ref={bottomSheetRef}
      index={-1}
      snapPoints={snapPoints}
      enablePanDownToClose
      onChange={handleSheetChange}
      backdropComponent={renderBackdrop}
      backgroundStyle={{ 
        backgroundColor: colorScheme === 'dark' ? '#161618' : '#FFFFFF'
      }}
      handleIndicatorStyle={{ 
        backgroundColor: colorScheme === 'dark' ? '#3F3F46' : '#D4D4D8',
        width: 36,
        height: 5,
        borderRadius: 3,
        marginTop: 8,
        marginBottom: 0
      }}
      enableDynamicSizing={false}
      style={{
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
        overflow: 'hidden'
      }}
    >
      <View className="flex-1 px-6 pb-6">
        {/* Header with Back Button */}
        <View className="mb-6 mt-6 flex-row items-center">
          <Pressable
            onPress={handleBackPress}
            className="bg-primary/15 rounded-full w-10 h-10 items-center justify-center active:opacity-70 mr-3"
          >
            <Icon as={ChevronLeft} size={20} className="text-foreground" />
          </Pressable>
          
          <View className="flex-1">
            <Text className="text-foreground text-xl font-roobert-semibold">{t('models.selectModel')}</Text>
            <Text className="text-foreground/60 text-sm font-roobert mt-1">
              {t('models.chooseModelFor', { agent: agent.name })}
            </Text>
          </View>
        </View>

        {/* Agent Info */}
        <View className="flex-row items-center mb-6 p-4 bg-primary/5 rounded-2xl">
          <AgentAvatar agent={agent} size={32} />
          <View className="ml-3 flex-1">
            <Text className="text-foreground text-base font-roobert-medium">
              {agent.name}
            </Text>
            {agent.description && (
              <Text className="text-foreground/60 text-sm font-roobert mt-0.5">
                {agent.description}
              </Text>
            )}
          </View>
        </View>

        {/* Model List */}
        <BottomSheetScrollView 
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 20 }}
        >
          {agent.models?.map((model) => {
            const isSelected = model.id === selectedModelId;
            
            return (
              <Pressable
                key={model.id}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  console.log('🤖 Model Selected:', {
                    modelId: model.id,
                    modelName: model.name,
                    agentId: agent.id,
                    agentName: agent.name,
                    timestamp: new Date().toISOString()
                  });
                  onSelectModel(model);
                  onClose();
                }}
                className={`flex-row items-center p-4 rounded-2xl mb-2 active:opacity-70 ${
                  isSelected ? 'bg-primary/15' : 'bg-primary/5'
                }`}
              >
                <View 
                  className="items-center justify-center rounded-2xl"
                  style={{
                    width: 48,
                    height: 48,
                    backgroundColor: model.backgroundColor,
                    borderWidth: 1.2,
                    borderColor: colorScheme === 'dark' ? '#232324' : '#E4E4E7'
                  }}
                >
                  <Icon 
                    as={model.icon} 
                    size={20} 
                    color={model.iconColor}
                    strokeWidth={2}
                  />
                </View>
                <View className="ml-3 flex-1">
                  <Text className="text-foreground text-base font-roobert-medium">
                    {model.name}
                  </Text>
                  {model.description && (
                    <Text className="text-foreground/60 text-sm font-roobert mt-0.5">
                      {model.description}
                    </Text>
                  )}
                </View>
                {isSelected && (
                  <View className="w-2 h-2 rounded-full bg-foreground" />
                )}
              </Pressable>
            );
          })}
        </BottomSheetScrollView>
      </View>
    </BottomSheet>
  );
}
