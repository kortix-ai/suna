import * as React from 'react';
import { Dimensions } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  runOnJS
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

const SCREEN_WIDTH = Dimensions.get('window').width;
const AnimatedView = Animated.createAnimatedComponent(Animated.View);

interface AnimatedPageWrapperProps {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
  disableGesture?: boolean;
}

export function AnimatedPageWrapper({ visible, onClose, children, disableGesture = false }: AnimatedPageWrapperProps) {
  const translateX = useSharedValue(SCREEN_WIDTH);
  const [shouldRender, setShouldRender] = React.useState(false);

  React.useEffect(() => {
    if (visible) {
      translateX.value = SCREEN_WIDTH;
      setShouldRender(true);
      requestAnimationFrame(() => {
        translateX.value = withTiming(0, { duration: 300 });
      });
    } else {
      translateX.value = withTiming(SCREEN_WIDTH, { duration: 300 }, (finished) => {
        if (finished) {
          runOnJS(setShouldRender)(false);
        }
      });
    }
  }, [visible]);

  const gesture = Gesture.Pan()
    .activeOffsetX([50, 50])
    .failOffsetY([-20, 20])
    .manualActivation(true)
    .onTouchesMove((event, state) => {
      // Only activate if horizontal swipe from edge
      const touch = event.allTouches[0];
      if (touch.x < 50 && touch.absoluteX - touch.x > 30) {
        state.activate();
      } else {
        state.fail();
      }
    })
    .onUpdate((event) => {
      if (event.translationX > 0) {
        translateX.value = event.translationX;
      }
    })
    .onEnd((event) => {
      if (event.translationX > SCREEN_WIDTH * 0.3 || event.velocityX > 500) {
        translateX.value = withTiming(SCREEN_WIDTH, { duration: 200 }, (finished) => {
          if (finished) {
            runOnJS(onClose)();
          }
        });
      } else {
        translateX.value = withTiming(0, { duration: 200 });
      }
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  if (!shouldRender) return null;

  if (disableGesture) {
    return (
      <AnimatedView
        style={animatedStyle}
        className="absolute inset-0 z-50"
      >
        {children}
      </AnimatedView>
    );
  }

  return (
    <GestureDetector gesture={gesture}>
      <AnimatedView
        style={animatedStyle}
        className="absolute inset-0 z-50"
      >
        {children}
      </AnimatedView>
    </GestureDetector>
  );
}

