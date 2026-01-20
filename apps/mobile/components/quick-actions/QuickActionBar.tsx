import * as React from 'react';
import { View, Dimensions, Pressable, Platform, ScrollView } from 'react-native';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import * as Haptics from 'expo-haptics';
import { useColorScheme } from 'nativewind';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { QUICK_ACTIONS } from './quickActions';
import { QuickAction } from '.';
import { useLanguage } from '@/contexts';
import { log } from '@/lib/logger';
import { ModeDrawer } from './ModeDrawer';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const ITEM_SPACING = 8;
const CONTAINER_PADDING = 0;

const ANDROID_HIT_SLOP = Platform.OS === 'android' ? { top: 12, bottom: 12, left: 12, right: 12 } : undefined;

interface QuickActionBarProps {
  actions?: QuickAction[];
  onSelectMode?: (modeId: string, prompt: string) => void;
}

interface ModeItemProps {
  action: QuickAction;
  onPress: () => void;
  isLast: boolean;
}

const ModeItem = React.memo(({ action, onPress, isLast }: ModeItemProps) => {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const translatedLabel = t(`quickActions.${action.id}`, { defaultValue: action.label });

  const itemContent = (
    <>
      <Icon 
        as={action.icon} 
        size={18} 
        className="text-foreground"
        strokeWidth={2}
        style={{ marginRight: 6 }}
      />
      <Text className="font-roobert-medium text-foreground">
        {translatedLabel}
      </Text>
    </>
  );

  return (
    <Pressable 
      onPress={onPress} 
      hitSlop={ANDROID_HIT_SLOP}
      style={{
        marginRight: isLast ? 0 : ITEM_SPACING,
      }}
    >
      <View 
          className="flex-row items-center rounded-full px-6 py-3 bg-muted"
        >
          {itemContent}
        </View>
    </Pressable>
  );
});

ModeItem.displayName = 'ModeItem';

export function QuickActionBar({ 
  actions = QUICK_ACTIONS,
  onSelectMode,
}: QuickActionBarProps) {
  const [drawerVisible, setDrawerVisible] = React.useState(false);
  const [selectedMode, setSelectedMode] = React.useState<QuickAction | null>(null);

  const handleModePress = React.useCallback((action: QuickAction) => {
    log.log('🎯 Mode pressed:', action.id);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSelectedMode(action);
    setDrawerVisible(true);
  }, []);

  const handleCloseDrawer = React.useCallback(() => {
    setDrawerVisible(false);
    setTimeout(() => setSelectedMode(null), 300);
  }, []);

  const handleSelectOption = React.useCallback(
    (optionId: string) => {
      log.log('🎯 Mode option selected:', selectedMode?.id, optionId);
      if (selectedMode) {
        // Generate prompt based on mode and option
        const prompt = `${selectedMode.label}: ${optionId}`;
        onSelectMode?.(selectedMode.id, prompt);
      }
    },
    [selectedMode, onSelectMode]
  );

  return (
    <>
      <View className="w-full overflow-hidden mb-3">
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{
            paddingHorizontal: CONTAINER_PADDING,
            flexDirection: 'row',
            alignItems: 'center',
          }}
          decelerationRate="fast"
        >
          {actions.map((action, index) => (
            <ModeItem
              key={action.id}
              action={action}
              onPress={() => handleModePress(action)}
              isLast={index === actions.length - 1}
            />
          ))}
        </ScrollView>
      </View>

      <ModeDrawer
        visible={drawerVisible}
        mode={selectedMode}
        onClose={handleCloseDrawer}
        onSelectOption={handleSelectOption}
      />
    </>
  );
}
