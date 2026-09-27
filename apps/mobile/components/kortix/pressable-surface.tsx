/**
 * A `Pressable` whose style depends on the pressed state.
 *
 * NativeWind's css-interop wraps every React Native `Pressable` and reads its
 * `style` prop as a plain style object. A function style
 * (`style={({ pressed }) => …}`) has no keys, so it is dropped on device —
 * with every layout rule inside it. This component tracks `pressed` itself
 * and passes the resolved object, which css-interop keeps.
 */
import { useState } from 'react';
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';

export interface PressableSurfaceProps extends Omit<PressableProps, 'style'> {
  style: (state: { pressed: boolean }) => StyleProp<ViewStyle>;
}

export function PressableSurface({ style, onPressIn, onPressOut, ...props }: PressableSurfaceProps) {
  const [pressed, setPressed] = useState(false);
  return (
    <Pressable
      {...props}
      onPressIn={(event) => {
        setPressed(true);
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        setPressed(false);
        onPressOut?.(event);
      }}
      style={style({ pressed })}
    />
  );
}
