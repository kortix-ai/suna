import React from 'react';
import { View, Pressable } from 'react-native';
import { Icon } from '@/components/ui/icon';
import { Zap, FolderOpen, Globe } from 'lucide-react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import type { ViewType } from '@/stores/kortix-computer-store';

interface ViewToggleProps {
  currentView: ViewType;
  onViewChange: (view: ViewType) => void;
  showFilesTab?: boolean;
}

const AnimatedView = Animated.createAnimatedComponent(View);

export function ViewToggle({ currentView, onViewChange, showFilesTab = true }: ViewToggleProps) {
  const viewOptions = showFilesTab
    ? ['tools', 'files', 'browser'] as const
    : ['tools', 'browser'] as const;

  const getViewIndex = (view: ViewType) => {
    // If files tab is hidden and current view is files, default to tools
    if (!showFilesTab && view === 'files') {
      return 0; // tools
    }
    const index = viewOptions.indexOf(view as any);
    return index >= 0 ? index : 0;
  };

  const tabWidth = 28; // w-7 = 28px
  const gap = 4; // gap-1 = 4px

  const indicatorPosition = useSharedValue(getViewIndex(currentView) * (tabWidth + gap));

  React.useEffect(() => {
    indicatorPosition.value = withSpring(getViewIndex(currentView) * (tabWidth + gap), {
      damping: 30,
      stiffness: 300,
    });
  }, [currentView, indicatorPosition, showFilesTab]);

  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: indicatorPosition.value }],
  }));

  const handlePress = (view: ViewType) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onViewChange(view);
  };

  return (
    <View className="relative flex-row items-center gap-1 bg-card border border-border rounded-full px-1 py-1">
      <AnimatedView
        className="absolute top-1 left-1 h-7 w-7 rounded-xl bg-primary"
        style={[indicatorStyle]}
      />

      <Pressable
        onPress={() => handlePress('tools')}
        className="relative z-10 h-7 w-7 items-center justify-center rounded-xl"
      >
        <Icon
          as={Zap}
          size={14}
          className={currentView === 'tools' ? 'text-primary-foreground' : 'text-primary'}
          strokeWidth={2}
        />
      </Pressable>

      {showFilesTab && (
        <Pressable
          onPress={() => handlePress('files')}
          className="relative z-10 h-7 w-7 items-center justify-center rounded-xl"
        >
          <Icon
            as={FolderOpen}
            size={14}
            className={currentView === 'files' ? 'text-primary-foreground' : 'text-primary'}
            strokeWidth={2}
          />
        </Pressable>
      )}

      <Pressable
        onPress={() => handlePress('browser')}
        className="relative z-10 h-7 w-7 items-center justify-center rounded-xl"
      >
        <Icon
          as={Globe}
          size={14}
          className={currentView === 'browser' ? 'text-primary-foreground' : 'text-primary'}
          strokeWidth={2}
        />
      </Pressable>
    </View>
  );
}

