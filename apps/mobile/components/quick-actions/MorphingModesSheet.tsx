import * as React from 'react';
import { View, Pressable, Platform, ScrollView, Image, Dimensions, StyleSheet } from 'react-native';
import { LiquidGlass } from '@/components/ui';
import * as Haptics from 'expo-haptics';
import { useColorScheme } from 'nativewind';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { X, ChevronLeft } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  runOnJS,
  interpolate,
  Extrapolate,
  withDelay,
  withSequence,
} from 'react-native-reanimated';
import { ReanimatedTrueSheet } from '@lodev09/react-native-true-sheet/reanimated';
import type { TrueSheet } from '@lodev09/react-native-true-sheet';
import { BottomSheetModal, BottomSheetBackdrop, BottomSheetView, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { getBorderRadius } from '@agentpress/shared';
import { QUICK_ACTIONS } from './quickActions';
import { QuickAction } from '.';
import { useLanguage } from '@/contexts';
import { getQuickActionOptions } from './quickActionViews';
import { DocPreviewCard } from './DocPreviewCard';
import { ResearchPreviewCard } from './ResearchPreviewCard';
import { DataPreviewCard } from './DataPreviewCard';
import { PeoplePreviewCard } from './PeoplePreviewCard';
import { shouldUseVisualPreview } from './previewConfig';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// Apple-like spring configs
const SPRING_BOUNCY = { damping: 14, stiffness: 400, mass: 0.6 };
const SPRING_SMOOTH = { damping: 20, stiffness: 300, mass: 0.8 };

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface MorphingModesSheetProps {
  isActive: boolean;
  onSelectMode?: (modeId: string, prompt: string) => void;
}

interface ModeCardProps {
  action: QuickAction;
  onPress: () => void;
  cardWidth: number;
}

const ModeCard = React.memo(function ModeCard({
  action,
  onPress,
  cardWidth,
}: ModeCardProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const { t } = useLanguage();
  const translatedLabel = t(`quickActions.${action.id}`, { defaultValue: action.label });
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <GestureDetector gesture={Gesture.Tap()
      .onBegin(() => {
        scale.value = withSpring(0.95, SPRING_BOUNCY);
      })
      .onEnd(() => {
        scale.value = withSpring(1, SPRING_BOUNCY);
        runOnJS(Haptics.impactAsync)(Haptics.ImpactFeedbackStyle.Medium);
        runOnJS(onPress)();
      })
      .onFinalize(() => {
        scale.value = withSpring(1, SPRING_BOUNCY);
      })
    }>
      <Animated.View style={[animatedStyle, { width: cardWidth }]}>
        <LiquidGlass
          isInteractive
          borderRadius={20}
          style={{
            paddingVertical: 18,
            paddingHorizontal: 12,
            alignItems: 'center',
            gap: 12,
          }}
        >
          <View
            style={{
              width: 52,
              height: 52,
              borderRadius: 22,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.06)',
            }}
          >
            <Icon as={action.icon} size={24} className="text-foreground" strokeWidth={2} />
          </View>
          <Text className="font-roobert-semibold text-sm text-foreground text-center" numberOfLines={1}>
            {translatedLabel}
          </Text>
        </LiquidGlass>
      </Animated.View>
    </GestureDetector>
  );
});

interface OptionCardProps {
  option: any;
  cardWidth: number;
  cardHeight: number;
  isSlideMode: boolean;
  isDocsMode: boolean;
  isResearchMode: boolean;
  isDataMode: boolean;
  isPeopleMode: boolean;
  onSelect: () => void;
}

const OptionCard = React.memo(function OptionCard({
  option,
  cardWidth,
  cardHeight,
  isSlideMode,
  isDocsMode,
  isResearchMode,
  isDataMode,
  isPeopleMode,
  onSelect,
}: OptionCardProps) {
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  // Check if we should use visual previews (respects config toggle)
  const useDocsVisual = isDocsMode && shouldUseVisualPreview('docs');
  const useResearchVisual = isResearchMode && shouldUseVisualPreview('research');
  const useDataVisual = isDataMode && shouldUseVisualPreview('data');
  const usePeopleVisual = isPeopleMode && shouldUseVisualPreview('people');

  return (
    <AnimatedPressable
      onPressIn={() => {
        scale.value = withSpring(0.96, SPRING_BOUNCY);
      }}
      onPressOut={() => {
        scale.value = withSpring(1, SPRING_BOUNCY);
      }}
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        onSelect();
      }}
      style={[animatedStyle, { width: cardWidth, marginBottom: 4 }]}
    >
      <View>
        {option.imageUrl ? (
          <View
            className="rounded-xl overflow-hidden mb-1.5 bg-muted/20"
            style={{ width: cardWidth, height: cardHeight }}
          >
            <Image
              source={option.imageUrl}
              style={{ width: '100%', height: '100%' }}
              resizeMode={isSlideMode ? 'contain' : 'cover'}
            />
          </View>
        ) : useDocsVisual ? (
          <View style={{ marginBottom: 6 }}>
            <DocPreviewCard
              docType={option.id}
              width={cardWidth}
              height={cardHeight}
            />
          </View>
        ) : useResearchVisual ? (
          <View style={{ marginBottom: 6 }}>
            <ResearchPreviewCard
              researchType={option.id}
              width={cardWidth}
              height={cardHeight}
            />
          </View>
        ) : useDataVisual ? (
          <View style={{ marginBottom: 6 }}>
            <DataPreviewCard
              dataType={option.id}
              width={cardWidth}
              height={cardHeight}
            />
          </View>
        ) : usePeopleVisual ? (
          <View style={{ marginBottom: 6 }}>
            <PeoplePreviewCard
              peopleType={option.id}
              width={cardWidth}
              height={cardHeight}
            />
          </View>
        ) : option.icon ? (
          <View
            className="rounded-xl items-center justify-center mb-1.5 bg-card border border-border/30"
            style={{ width: cardWidth, height: cardHeight }}
          >
            <Icon as={option.icon} size={32} className="text-foreground/70" strokeWidth={2} />
          </View>
        ) : null}
        <Text className="text-xs text-foreground/70 font-roobert text-center" numberOfLines={2}>
          {option.label}
        </Text>
      </View>
    </AnimatedPressable>
  );
});

export function MorphingModesSheet({ isActive, onSelectMode }: MorphingModesSheetProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();

  // Refs
  const trueSheetRef = React.useRef<TrueSheet>(null);
  const bottomSheetRef = React.useRef<BottomSheetModal>(null);

  // State
  const [selectedMode, setSelectedMode] = React.useState<QuickAction | null>(null);
  const [isSheetOpen, setIsSheetOpen] = React.useState(false);

  // Animation values for button
  const buttonScale = useSharedValue(1);
  const buttonOpacity = useSharedValue(1);

  const cornerRadius = getBorderRadius(Platform.OS, '3xl');

  const modeOptions = React.useMemo(() => {
    if (!selectedMode) return [];
    return getQuickActionOptions(selectedMode.id);
  }, [selectedMode]);

  // Open sheet with animation
  const openSheet = React.useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsSheetOpen(true);
    
    // Button animation - scale up then fade
    buttonScale.value = withSequence(
      withSpring(1.1, { damping: 10, stiffness: 400 }),
      withSpring(0.9, SPRING_SMOOTH)
    );
    buttonOpacity.value = withDelay(50, withTiming(0.5, { duration: 150 }));

    // Present sheet
    if (Platform.OS === 'ios') {
      trueSheetRef.current?.present();
    } else {
      bottomSheetRef.current?.present();
    }
  }, []);

  // Close sheet
  const closeSheet = React.useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    
    if (Platform.OS === 'ios') {
      trueSheetRef.current?.dismiss();
    } else {
      bottomSheetRef.current?.dismiss();
    }
  }, []);

  // Handle sheet dismiss
  const handleDismiss = React.useCallback(() => {
    setIsSheetOpen(false);
    setSelectedMode(null);
    buttonScale.value = withSpring(1, SPRING_BOUNCY);
    buttonOpacity.value = withTiming(1, { duration: 150 });
  }, []);

  // Select mode
  const handleSelectMode = React.useCallback((action: QuickAction) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSelectedMode(action);
  }, []);

  // Go back to modes
  const handleBack = React.useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedMode(null);
  }, []);

  // Select option
  const handleSelectOption = React.useCallback((optionId: string) => {
    if (selectedMode) {
      const option = modeOptions.find(o => o.id === optionId);
      const promptText = `${selectedMode.label}: ${option?.label || optionId}`;
      onSelectMode?.(selectedMode.id, promptText);
    }
    closeSheet();
  }, [selectedMode, modeOptions, onSelectMode, closeSheet]);

  // Button tap gesture
  const buttonGesture = Gesture.Tap()
    .onBegin(() => {
      buttonScale.value = withSpring(0.92, SPRING_BOUNCY);
    })
    .onEnd(() => {
      runOnJS(openSheet)();
    })
    .onFinalize(() => {
      if (!isSheetOpen) {
        buttonScale.value = withSpring(1, SPRING_BOUNCY);
      }
    });

  // Button animated style
  const buttonAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: buttonScale.value }],
    opacity: buttonOpacity.value,
  }));

  // Backdrop for Android
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

  const cardWidth = (SCREEN_WIDTH - 64) / 3;

  // Render modes grid
  const renderModesContent = () => {
    const ScrollComponent = Platform.OS === 'ios' ? ScrollView : BottomSheetScrollView;
    
    return (
      <View style={{ flex: 1 }}>
        <View style={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: 16 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <View>
              <Text className="font-roobert-bold text-2xl text-foreground">
                Presets
              </Text>
              <Text className="font-roobert text-sm text-muted-foreground mt-1">
                Pick from presets to get started
              </Text>
            </View>
            <Pressable onPress={closeSheet}>
              <LiquidGlass
                tintColor={isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.04)'}
                isInteractive
                borderRadius={18}
                borderWidth={1}
                borderColor={isDark ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.1)'}
                style={{
                  width: 36,
                  height: 36,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icon as={X} size={18} className="text-muted-foreground" strokeWidth={2.5} />
              </LiquidGlass>
            </Pressable>
          </View>
        </View>

        <ScrollComponent
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingBottom: Math.max(insets.bottom, 20) + 40,
          }}
        >
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            {QUICK_ACTIONS.map((action) => (
              <ModeCard
                key={action.id}
                action={action}
                cardWidth={cardWidth}
                onPress={() => handleSelectMode(action)}
              />
            ))}
          </View>
        </ScrollComponent>
      </View>
    );
  };

  const renderOptionsContent = () => {
    if (!selectedMode) return null;

    const ScrollComponent = Platform.OS === 'ios' ? ScrollView : BottomSheetScrollView;
    const isSlideMode = selectedMode.id === 'slides';
    const isDocsMode = selectedMode.id === 'docs';
    const isResearchMode = selectedMode.id === 'research';
    const isDataMode = selectedMode.id === 'data';
    const isPeopleMode = selectedMode.id === 'people';
    
    let optionCardWidth: number;
    let optionCardHeight: number;
    
    if (isSlideMode) {
      optionCardWidth = (SCREEN_WIDTH - 44) / 2;
      optionCardHeight = optionCardWidth * 0.5625;
    } else if (isDocsMode && shouldUseVisualPreview('docs')) {
      optionCardWidth = (SCREEN_WIDTH - 44) / 2;
      optionCardHeight = optionCardWidth * 1.2;
    } else if (isResearchMode && shouldUseVisualPreview('research')) {
      optionCardWidth = (SCREEN_WIDTH - 44) / 2;
      optionCardHeight = optionCardWidth;
    } else if (isDataMode && shouldUseVisualPreview('data')) {
      optionCardWidth = (SCREEN_WIDTH - 44) / 2;
      optionCardHeight = optionCardWidth;
    } else if (isPeopleMode && shouldUseVisualPreview('people')) {
      optionCardWidth = (SCREEN_WIDTH - 44) / 2;
      optionCardHeight = optionCardWidth;
    } else {
      optionCardWidth = (SCREEN_WIDTH - 56) / 3;
      optionCardHeight = optionCardWidth;
    }

    return (
      <View style={{ flex: 1 }}>
        <View style={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: 16 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Pressable onPress={handleBack}>
                <LiquidGlass
                  tintColor={isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.04)'}
                  isInteractive
                  borderRadius={18}
                  borderWidth={1}
                  borderColor={isDark ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.1)'}
                  style={{
                    width: 36,
                    height: 36,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Icon as={ChevronLeft} size={20} className="text-foreground" strokeWidth={2.5} />
                </LiquidGlass>
              </Pressable>
              <View>
                <Text className="font-roobert-bold text-2xl text-foreground">
                  {selectedMode.label}
                </Text>
                <Text className="font-roobert text-sm text-muted-foreground mt-1">
                  Choose a template
                </Text>
              </View>
            </View>
            <Pressable onPress={closeSheet}>
              <LiquidGlass
                tintColor={isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.04)'}
                isInteractive
                borderRadius={18}
                borderWidth={1}
                borderColor={isDark ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.1)'}
                style={{
                  width: 36,
                  height: 36,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icon as={X} size={18} className="text-muted-foreground" strokeWidth={2.5} />
              </LiquidGlass>
            </Pressable>
          </View>
        </View>

        <ScrollComponent
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingBottom: Math.max(insets.bottom, 20) + 40,
          }}
        >
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
            {modeOptions.map((option) => (
              <OptionCard
                key={option.id}
                option={option}
                cardWidth={optionCardWidth}
                cardHeight={optionCardHeight}
                isSlideMode={isSlideMode}
                isDocsMode={isDocsMode}
                isResearchMode={isResearchMode}
                isDataMode={isDataMode}
                isPeopleMode={isPeopleMode}
                onSelect={() => handleSelectOption(option.id)}
              />
            ))}
          </View>
        </ScrollComponent>
      </View>
    );
  };

  const sheetContent = selectedMode ? renderOptionsContent() : renderModesContent();

  const textContent = (
    <Text className={`text-xs font-roobert-medium ${isActive ? 'text-foreground' : 'text-muted-foreground'}`}>
      Presets
    </Text>
  );

  return (
    <>
      {/* Button */}
      <GestureDetector gesture={buttonGesture}>
        <Animated.View style={buttonAnimatedStyle}>
          <LiquidGlass
            tintColor={isDark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.03)'}
            borderRadius={12}
            borderWidth={0.5}
            borderColor={isActive
              ? (isDark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.15)')
              : (isDark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.05)')}
            style={{
              paddingHorizontal: 12,
              paddingVertical: 6,
            }}
          >
            {textContent}
          </LiquidGlass>
        </Animated.View>
      </GestureDetector>

      {/* iOS TrueSheet with liquid glass */}
      {Platform.OS === 'ios' && (
        <ReanimatedTrueSheet
          ref={trueSheetRef}
          detents={selectedMode ? [0.85, 1] : [0.4, 0.85, 1]}
          onDidDismiss={handleDismiss}
          cornerRadius={cornerRadius}
          initialDetentIndex={0}
        >
          {sheetContent}
        </ReanimatedTrueSheet>
      )}

      {/* Android BottomSheetModal */}
      {Platform.OS === 'android' && (
        <BottomSheetModal
          ref={bottomSheetRef}
          snapPoints={selectedMode ? ['85%'] : ['60%', '85%']}
          enablePanDownToClose
          onDismiss={handleDismiss}
          backdropComponent={renderBackdrop}
          backgroundStyle={{
            backgroundColor: isDark ? '#1c1c1e' : '#ffffff',
            borderTopLeftRadius: cornerRadius,
            borderTopRightRadius: cornerRadius,
          }}
          handleIndicatorStyle={{
            backgroundColor: isDark ? '#3F3F46' : '#D4D4D8',
            width: 36,
            height: 5,
            borderRadius: 3,
          }}
        >
          <BottomSheetView style={{ flex: 1 }}>
            {sheetContent}
          </BottomSheetView>
        </BottomSheetModal>
      )}
    </>
  );
}
