/**
 * Six digit cells in two groups of three: web's `CodeCells`
 * (apps/web/src/features/auth/mfa-step-up.tsx). One real TextInput sits on
 * top of the cells, transparent, so typing, paste and one-time-code autofill
 * behave like a plain text field; the cells only draw its value.
 *
 * The group that holds the next digit gets the foreground border and a soft
 * 3 px ring. A wrong code turns both groups destructive.
 */

import * as React from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { useColorScheme } from 'nativewind';

import { Text } from '@/components/ui/text';
import { THEME, withAlpha } from '@/lib/utils/theme';

export const CODE_LENGTH = 6;

const GROUPS = [
  [0, 1, 2],
  [3, 4, 5],
] as const;
/** Design cell: 48 × 56. Cells shrink on narrow screens, never grow. */
const CELL_WIDTH = 48;
const CELL_HEIGHT = 56;
const RING = 3;

interface CodeCellsProps {
  value: string;
  /** Receives digits only, at most `CODE_LENGTH`. */
  onChangeText: (code: string) => void;
  invalid?: boolean;
  editable?: boolean;
  accessibilityLabel?: string;
}

export function CodeCells({
  value,
  onChangeText,
  invalid = false,
  editable = true,
  accessibilityLabel,
}: CodeCellsProps) {
  const { colorScheme } = useColorScheme();
  const colors = THEME[colorScheme === 'dark' ? 'dark' : 'light'];
  const [focused, setFocused] = React.useState(false);
  const active = focused ? Math.min(value.length, CODE_LENGTH - 1) : -1;

  return (
    <View style={styles.row}>
      {GROUPS.map((cells, g) => {
        const holdsActive = (cells as readonly number[]).includes(active);
        const border = invalid
          ? colors.destructive
          : holdsActive
            ? colors.foreground
            : colors.border;
        return (
          <React.Fragment key={g}>
            {g > 0 ? (
              <View
                style={[styles.dash, { backgroundColor: withAlpha(colors.mutedForeground, 0.6) }]}
              />
            ) : null}
            <View
              style={[
                styles.ring,
                {
                  borderColor:
                    holdsActive && !invalid ? withAlpha(colors.foreground, 0.08) : 'transparent',
                },
              ]}>
              <View style={[styles.group, { borderColor: border }]}>
                {cells.map((i) => (
                  <View
                    key={i}
                    style={[
                      styles.cell,
                      i !== cells[cells.length - 1] && {
                        borderRightWidth: 1,
                        borderRightColor: colors.border,
                      },
                    ]}>
                    {value[i] ? (
                      <Text className="font-mono text-foreground" style={styles.digit}>
                        {value[i]}
                      </Text>
                    ) : i === active ? (
                      <Caret color={colors.foreground} />
                    ) : null}
                  </View>
                ))}
              </View>
            </View>
          </React.Fragment>
        );
      })}
      <TextInput
        value={value}
        onChangeText={(text) => onChangeText(text.replace(/\D/g, '').slice(0, CODE_LENGTH))}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        editable={editable}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        maxLength={CODE_LENGTH}
        autoFocus
        caretHidden
        accessibilityLabel={accessibilityLabel}
        style={[StyleSheet.absoluteFill, styles.input]}
      />
    </View>
  );
}

/** Web's `animate-pulse` caret; still under reduce motion. */
function Caret({ color }: { color: string }) {
  const reduceMotion = useReducedMotion();
  const opacity = useSharedValue(1);

  React.useEffect(() => {
    if (reduceMotion) return;
    opacity.value = withRepeat(
      withSequence(withTiming(0.5, { duration: 1000 }), withTiming(1, { duration: 1000 })),
      -1
    );
    return () => cancelAnimation(opacity);
  }, [opacity, reduceMotion]);

  const animated = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View style={[styles.caret, { backgroundColor: color }, animated]} />;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 - RING },
  ring: {
    flex: 1,
    maxWidth: CELL_WIDTH * 3 + 2 + RING * 2,
    borderWidth: RING,
    borderRadius: 8 + RING,
  },
  group: { flexDirection: 'row', borderWidth: 1, borderRadius: 8, overflow: 'hidden' },
  cell: { flex: 1, height: CELL_HEIGHT, alignItems: 'center', justifyContent: 'center' },
  digit: { fontSize: 24, lineHeight: 28 },
  dash: { width: 10, height: 1.5 },
  caret: { width: 1.5, height: 22 },
  // Transparent, not hidden: it must still take focus, touches and paste.
  input: { opacity: 0, color: 'transparent' },
});
