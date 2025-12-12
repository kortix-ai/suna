import * as React from 'react';
import { Dimensions } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  runOnJS
} from 'react-native-reanimated';

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

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  if (!shouldRender) return null;

  // Simplified version without GestureDetector - just animated slide
  return (
    <AnimatedView
      style={animatedStyle}
      className="absolute inset-0 z-50"
    >
      {children}
    </AnimatedView>
  );
}
