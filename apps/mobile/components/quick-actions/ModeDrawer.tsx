import * as React from 'react';
import { View, ScrollView, Pressable, Platform, Image, Dimensions } from 'react-native';
import { BottomSheetModal, BottomSheetBackdrop, BottomSheetView } from '@gorhom/bottom-sheet';
import { LiquidGlass } from '@/components/ui';
import { LinearGradient } from 'expo-linear-gradient';
import { useColorScheme } from 'nativewind';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { X } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import type { QuickAction } from '.';
import { getQuickActionOptions, type QuickActionOption } from './quickActionViews';
import { getBorderRadius } from '@agentpress/shared';
import { ReanimatedTrueSheet } from '@lodev09/react-native-true-sheet/reanimated';
import type { TrueSheet } from '@lodev09/react-native-true-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring,
  useAnimatedScrollHandler,
  interpolate,
  Extrapolation,
} from 'react-native-reanimated';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const AnimatedScrollView = Animated.createAnimatedComponent(ScrollView);
const { width: SCREEN_WIDTH } = Dimensions.get('window');

interface ModeDrawerProps {
  visible: boolean;
  mode: QuickAction | null;
  onClose: () => void;
  onSelectOption: (optionId: string) => void;
}

export function ModeDrawer({ visible, mode, onClose, onSelectOption }: ModeDrawerProps) {
  const { colorScheme } = useColorScheme();
  const insets = useSafeAreaInsets();
  
  // TrueSheet for iOS with liquid glass
  const trueSheetRef = React.useRef<TrueSheet>(null);
  
  // BottomSheetModal fallback for Android
  const bottomSheetRef = React.useRef<BottomSheetModal>(null);
  const wasOpenRef = React.useRef(false);
  
  // Get border radius from app-styles
  const cornerRadius = getBorderRadius(Platform.OS, '3xl'); // iOS: 38pt, Android: 28dp
  
  // Scroll position for gradient effect
  const scrollY = useSharedValue(0);
  
  // Get actual options from quickActionViews
  const options = React.useMemo(() => {
    if (!mode) return [];
    return getQuickActionOptions(mode.id);
  }, [mode]);

  // Handle opening/closing the modal when visible prop changes
  React.useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = visible && !!mode;

    if (visible && mode && !wasOpen) {
      console.log('📂 Opening drawer for:', mode.id);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      if (Platform.OS === 'ios') {
        trueSheetRef.current?.present();
      } else {
        bottomSheetRef.current?.present();
      }
    } else if ((!visible || !mode) && wasOpen) {
      console.log('📥 Closing drawer');
      if (Platform.OS === 'ios') {
        trueSheetRef.current?.dismiss();
      } else {
        bottomSheetRef.current?.dismiss();
      }
    }
  }, [visible, mode]);

  const handleClose = React.useCallback(() => {
    console.log('📥 Closing drawer');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  }, [onClose]);

  const handleDismiss = React.useCallback(() => {
    onClose();
  }, [onClose]);

  const handleSelectOption = React.useCallback(
    (optionId: string) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      onSelectOption(optionId);
      handleClose();
    },
    [onSelectOption, handleClose]
  );

  const scrollHandler = useAnimatedScrollHandler({
    onScroll: (event) => {
      scrollY.value = event.contentOffset.y;
    },
  });

  const gradientStyle = useAnimatedStyle(() => {
    const opacity = interpolate(
      scrollY.value,
      [0, 50],
      [0, 1],
      Extrapolation.CLAMP
    );

    return {
      opacity,
    };
  });

  const renderBackdrop = React.useCallback(
    (props: any) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={0.5}
        pressBehavior="close"
        onPress={handleDismiss}
      />
    ),
    [handleDismiss]
  );

  if (!mode) return null;

  console.log('🎨 Rendering ModeDrawer for:', mode.id);

  const drawerContent = (
    <View style={{ flex: 1, paddingBottom: Math.max(insets.bottom, 20) + 20 }}>
      <View className="flex-row items-center justify-between px-6 pt-6 pb-4">
        <View className="flex-row items-center gap-3">
          <View>
            <Text className="font-roobert-semibold text-xl text-foreground">{mode.label}</Text>
            <Text className="font-roobert text-sm text-muted-foreground">
              Choose a template to get started
            </Text>
          </View>
        </View>
        <Pressable onPress={handleDismiss}>
          <LiquidGlass
            tintColor={colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.04)'}
            isInteractive
            borderRadius={18}
            borderWidth={1}
            borderColor={colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.1)'}
            style={{
              width: 36,
              height: 36,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon as={X} size={18} className="text-muted-foreground" strokeWidth={2} />
          </LiquidGlass>
        </Pressable>
      </View>
      <ScrollView
        showsVerticalScrollIndicator={false}
        bounces={true}
        scrollEventThrottle={16}
        contentContainerStyle={{ 
          paddingBottom: 60, 
          paddingHorizontal: 16,
          paddingTop: 8,
          flexGrow: 1,
        }}>
        <View 
          style={{ 
            flexDirection: 'row', 
            flexWrap: 'wrap',
            gap: 12,
          }}
        >
          {options.map((option) => (
            <OptionCard
              key={option.id}
              option={option}
              modeId={mode.id}
              onSelect={() => handleSelectOption(option.id)}
            />
          ))}
        </View>
      </ScrollView>
    </View>
  );

  if (Platform.OS === 'ios') {
    return (
      <ReanimatedTrueSheet
        key={`mode-drawer-${mode.id}`}
        ref={trueSheetRef}
        detents={[0.1, 0.8, 1]}
        onDidDismiss={handleDismiss}
        cornerRadius={cornerRadius}
        initialDetentIndex={0}
      >
        {drawerContent}
      </ReanimatedTrueSheet>
    );
  }

  // Android fallback
  return (
    <BottomSheetModal
      key={`mode-drawer-${mode.id}`}
      ref={bottomSheetRef}
      index={0}
      snapPoints={['80%']}
      enablePanDownToClose={true}
      enableDynamicSizing={false}
      onDismiss={handleDismiss}
      backdropComponent={renderBackdrop}
      handleComponent={null}
      backgroundStyle={{
        backgroundColor: colorScheme === 'dark' ? '#1C1C1E' : '#FFFFFF',
        borderTopLeftRadius: cornerRadius,
        borderTopRightRadius: cornerRadius,
      }}>
      <BottomSheetView style={{ flex: 1 }}>
        {drawerContent}
      </BottomSheetView>
    </BottomSheetModal>
  );
}

interface OptionCardProps {
  option: QuickActionOption;
  modeId: string;
  onSelect: () => void;
}

function OptionCard({ option, modeId, onSelect }: OptionCardProps) {
  const { colorScheme } = useColorScheme();
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  // Determine card size based on mode
  const isSlideMode = modeId === 'slides';
  const isImageMode = modeId === 'image';
  const cardWidth = isSlideMode ? (SCREEN_WIDTH - 48) / 2 : (SCREEN_WIDTH - 52) / 3;
  const cardHeight = isSlideMode ? cardWidth * 0.5625 : cardWidth;

  return (
    <AnimatedPressable
      onPressIn={() => {
        scale.value = withSpring(0.96, { damping: 15, stiffness: 400 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, { damping: 15, stiffness: 400 });
      }}
      onPress={onSelect}
      style={[
        animatedStyle,
        {
          width: cardWidth,
          marginBottom: 4,
        },
      ]}>
      <View>
        {/* Image or Icon Preview */}
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
        ) : option.icon ? (
          <View 
            className="rounded-xl items-center justify-center mb-1.5 bg-card border border-border/30" 
            style={{ width: cardWidth, height: cardHeight }}
          >
            <Icon 
              as={option.icon} 
              size={32} 
              className="text-foreground/70"
              strokeWidth={2}
            />
          </View>
        ) : null}
        
        {/* Label */}
        <Text 
          className="text-xs text-foreground/70 font-roobert text-center"
          numberOfLines={2}
        >
          {option.label}
        </Text>
      </View>
    </AnimatedPressable>
  );
}
