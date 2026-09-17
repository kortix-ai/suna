import { Platform, Pressable } from 'react-native';
import Animated from 'react-native-reanimated';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * This component is used to wrap animated views that should only be animated on native.
 * @param props - The props for the animated view.
 * @returns The animated view if the platform is native, otherwise the children.
 * @example
 * <NativeOnlyAnimatedView entering={FadeIn} exiting={FadeOut}>
 *   <Text>I am only animated on native</Text>
 * </NativeOnlyAnimatedView>
 */
function NativeOnlyAnimatedView(
  props: (React.ComponentProps<typeof Animated.View> & React.RefAttributes<typeof Animated.View> 
    & { as?: "View" }) | (React.ComponentProps<typeof AnimatedPressable> & React.RefAttributes<typeof AnimatedPressable> & { as: "Pressable" })
) {
  if (Platform.OS === 'web') {
    return <>{props.children as React.ReactNode}</>;
  } else {
    if (props.as === "Pressable"){
      return <AnimatedPressable {...props} />;
    }
    // Upstream RNR typing gap: the union prop type above doesn't narrow to the
    // `Animated.View` branch here, so this cast is needed to typecheck. This
    // reproduces identically against stock (scratchpad/registry/stock/native-only-animated-view.tsx).
    // The runtime branch above already rules out the Pressable shape.
    return <Animated.View {...(props as React.ComponentProps<typeof Animated.View>)} />;
  }
}

export { NativeOnlyAnimatedView };
