import * as React from 'react';
import { useWindowDimensions } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  runOnJS
} from 'react-native-reanimated';

const AnimatedView = Animated.createAnimatedComponent(Animated.View);

interface AnimatedPageWrapperProps {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
  disableGesture?: boolean;
}

export function AnimatedPageWrapper({ visible, onClose, children, disableGesture = false }: AnimatedPageWrapperProps) {
  // Read per render: the window width changes on rotation and iPad resizing.
  const { width: screenWidth } = useWindowDimensions();
  const translateX = useSharedValue(screenWidth);
  const [shouldRender, setShouldRender] = React.useState(false);

  React.useEffect(() => {
    if (visible) {
      translateX.value = screenWidth;
      setShouldRender(true);
      requestAnimationFrame(() => {
        translateX.value = withTiming(0, { duration: 300 });
      });
    } else {
      translateX.value = withTiming(screenWidth, { duration: 300 }, (finished) => {
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
