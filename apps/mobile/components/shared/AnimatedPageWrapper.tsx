import * as React from 'react';
import { Dimensions } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  runOnJS,
  Easing,
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
      setShouldRender(true);
      translateX.value = withTiming(0, { 
        duration: 200,
        easing: Easing.out(Easing.exp),
      });
    } else {
      translateX.value = withTiming(SCREEN_WIDTH, { 
        duration: 200,
        easing: Easing.out(Easing.exp),
      }, (finished) => {
        if (finished) {
          runOnJS(setShouldRender)(false);
        }
      });
    }
  }, [visible]);

  const animatedStyle = useAnimatedStyle(() => {
    const progress = 1 - (translateX.value / SCREEN_WIDTH);
    
    return {
      transform: [{ translateX: translateX.value }],
      opacity: 0.3 + (progress * 0.7), // Fade in from 0.3 to 1
    };
  });

  if (!shouldRender) return null;

  return (
    <AnimatedView
      style={animatedStyle}
      className="absolute inset-0 z-50"
    >
      {children}
    </AnimatedView>
  );
}
