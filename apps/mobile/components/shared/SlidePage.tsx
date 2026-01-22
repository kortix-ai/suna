import * as React from 'react';
import { View, StyleSheet, Dimensions, Pressable } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  Easing,
  runOnJS,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import * as Haptics from 'expo-haptics';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// iOS-native spring configuration - incredibly snappy and smooth
export const IOS_SPRING = {
  damping: 30,
  stiffness: 400,
  mass: 0.8,
  overshootClamping: false,
  restDisplacementThreshold: 0.01,
  restSpeedThreshold: 2,
};

// Fast spring for quick interactions
export const FAST_SPRING = {
  damping: 25,
  stiffness: 500,
  mass: 0.6,
  overshootClamping: false,
};

// iOS bezier curve for timing animations
const IOS_EASING = Easing.bezier(0.25, 0.1, 0.25, 1);

interface SlidePageProps {
  children: React.ReactNode;
  visible: boolean;
  onClose?: () => void;
  enableSwipeToClose?: boolean;
  showOverlay?: boolean;
  overlayOpacity?: number;
  style?: any;
}

/**
 * SlidePage - iOS-native feeling page transitions
 * 
 * Simple, fast, and smooth - just like native iOS.
 * Uses hardware-accelerated animations for 60fps performance.
 */
export function SlidePage({
  children,
  visible,
  onClose,
  enableSwipeToClose = true,
  showOverlay = true,
  overlayOpacity = 0.3,
  style,
}: SlidePageProps) {
  const translateX = useSharedValue(SCREEN_WIDTH);
  const overlayOp = useSharedValue(0);
  const [shouldRender, setShouldRender] = React.useState(false);

  // Safe callbacks
  const handleClose = React.useCallback(() => {
    onClose?.();
  }, [onClose]);

  const handleCloseWithDelay = React.useCallback(() => {
    setTimeout(() => {
      onClose?.();
    }, 200);
  }, [onClose]);

  const triggerHaptic = React.useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, []);

  React.useEffect(() => {
    if (visible) {
      setShouldRender(true);
      
      // Start animation on next frame
      requestAnimationFrame(() => {
        translateX.value = withSpring(0, IOS_SPRING);
        overlayOp.value = withTiming(overlayOpacity, {
          duration: 250,
          easing: IOS_EASING,
        });
      });
    } else if (shouldRender) {
      // Exit animation
      translateX.value = withSpring(SCREEN_WIDTH, FAST_SPRING);
      overlayOp.value = withTiming(0, {
        duration: 200,
        easing: IOS_EASING,
      }, (finished) => {
        if (finished) {
          runOnJS(setShouldRender)(false);
        }
      });
    }
  }, [visible, overlayOpacity]);

  // Swipe to close gesture
  const panGesture = React.useMemo(
    () =>
      Gesture.Pan()
        .enabled(enableSwipeToClose && visible)
        .activeOffsetX([10, Infinity])
        .failOffsetX([-10, 0])
        .onUpdate((event) => {
          'worklet';
          translateX.value = Math.max(0, event.translationX);
          const progress = Math.min(event.translationX / SCREEN_WIDTH, 1);
          overlayOp.value = overlayOpacity * (1 - progress);
        })
        .onEnd((event) => {
          'worklet';
          const shouldClose = event.translationX > SCREEN_WIDTH * 0.25 || event.velocityX > 800;

          if (shouldClose) {
            runOnJS(triggerHaptic)();
            translateX.value = withSpring(SCREEN_WIDTH, FAST_SPRING);
            overlayOp.value = withTiming(0, { duration: 200 });
            runOnJS(handleCloseWithDelay)();
          } else {
            translateX.value = withSpring(0, IOS_SPRING);
            overlayOp.value = withTiming(overlayOpacity, { duration: 200 });
          }
        }),
    [enableSwipeToClose, visible, overlayOpacity, handleCloseWithDelay, triggerHaptic]
  );

  const pageStyle = useAnimatedStyle(() => {
    'worklet';
    return {
      transform: [{ translateX: translateX.value }],
    };
  });

  const overlayStyle = useAnimatedStyle(() => {
    'worklet';
    return {
      opacity: overlayOp.value,
    };
  });

  if (!shouldRender) return null;

  return (
    <View 
      style={StyleSheet.absoluteFill} 
      pointerEvents={visible ? 'auto' : 'none'}>
      {/* Overlay */}
      {showOverlay && (
        <Pressable 
          style={StyleSheet.absoluteFill}
          onPress={handleClose}>
          <Animated.View
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: 'rgba(0, 0, 0, 1)' },
              overlayStyle,
            ]}
          />
        </Pressable>
      )}
      
      {/* Page Content */}
      <GestureDetector gesture={panGesture}>
        <Animated.View
          style={[
            {
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: 0,
              right: 0,
            },
            style,
            pageStyle,
          ]}
          pointerEvents="auto">
          {children}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

/**
 * Convenience wrapper with iOS-native defaults
 */
export function SlidePageFromRight(props: SlidePageProps) {
  return <SlidePage {...props} />;
}
