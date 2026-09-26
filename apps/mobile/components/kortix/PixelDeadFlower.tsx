import * as React from 'react';
import { View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';

/**
 * Pixel-art wilted flower in a pot. Empty-state art for lists with no rows.
 * One color at several opacities, so it stays monochrome in both themes.
 * One petal drops from the head to the pile beside the pot, in a loop.
 *
 * Legend: s stem · l leaf · c flower center · p petal · f fallen petal · P pot
 */
const GRID = [
  '................',
  '......sss.......',
  '.....s...s......',
  '.....s....s.....',
  '.....s....s.....',
  '.....s...ccc....',
  '.....s..pcccp...',
  '.....s..p.p.p...',
  '.....s..p...p...',
  '..ll.s..........',
  '.l..ls..........',
  '.....s..........',
  '.PPPPPPPPP......',
  '.PPPPPPPPP......',
  '..PPPPPPP.......',
  '..PPPPPPP..ff...',
];

const OPACITY: Record<string, number> = {
  s: 0.55,
  l: 0.45,
  c: 1,
  p: 0.8,
  f: 0.6,
  P: 0.35,
};

const COLS = GRID[0].length;
const ROWS = GRID.length;

// One path per tone. Each horizontal run of a tone is one rectangle, and all
// runs share one fill, so adjacent pixels render without anti-aliased seams.
const TONES = Object.entries(OPACITY).map(([tone, opacity]) => {
  let d = '';
  GRID.forEach((row, y) => {
    for (const match of row.matchAll(new RegExp(`${tone}+`, 'g'))) {
      d += `M${match.index} ${y}h${match[0].length}v1h-${match[0].length}z`;
    }
  });
  return { tone, opacity, d };
});

// The falling petal's cells, one per step: it leaves the right petal tip,
// sways right then left, and lands on the pile at (11, 15). Whole-cell steps
// keep the motion on the pixel grid.
const FALL_X = [12, 12, 13, 13, 12, 11, 11];
const FALL_Y = [9, 10, 11, 12, 13, 14, 15];
const STEPS = FALL_X.length;

// One cycle, as fractions of CYCLE_MS: fade in, fall, rest on the pile, fade out.
const CYCLE_MS = 3200;
const PAUSE_MS = 900;
const FADE_IN_END = 0.06;
const FALL_END = 0.6;
const FADE_OUT_START = 0.82;
/** Where the petal rests when the loop is off: one cell below the head. */
const STILL_PROGRESS = FALL_END / STEPS + 0.01;

interface PixelDeadFlowerProps {
  color: string;
  /** Rendered width in points. Height follows the grid ratio. */
  size?: number;
  /** Run the petal loop. Pass false while the art is off screen. */
  animate?: boolean;
}

export function PixelDeadFlower({ color, size = 72, animate = true }: PixelDeadFlowerProps) {
  const cell = size / COLS;
  const reduceMotion = useReducedMotion();
  const playing = animate && !reduceMotion;
  const progress = useSharedValue(STILL_PROGRESS);

  React.useEffect(() => {
    if (!playing) {
      cancelAnimation(progress);
      progress.value = STILL_PROGRESS;
      return;
    }
    // Linear: the fall is stepped below, so easing would only skew step timing.
    progress.value = 0;
    progress.value = withRepeat(
      withDelay(PAUSE_MS, withTiming(1, { duration: CYCLE_MS, easing: Easing.linear })),
      -1
    );
    return () => cancelAnimation(progress);
  }, [playing, progress]);

  const petalStyle = useAnimatedStyle(() => {
    const t = progress.value;
    const step = Math.min(STEPS - 1, Math.floor((t / FALL_END) * STEPS));
    let opacity = OPACITY.f;
    if (t < FADE_IN_END) opacity *= t / FADE_IN_END;
    else if (t > FADE_OUT_START) opacity *= Math.max(0, (1 - t) / (1 - FADE_OUT_START));
    return {
      opacity,
      transform: [{ translateX: FALL_X[step] * cell }, { translateY: FALL_Y[step] * cell }],
    };
  });

  return (
    <View
      style={{ width: size, height: (size * ROWS) / COLS }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants">
      <Svg width="100%" height="100%" viewBox={`0 0 ${COLS} ${ROWS}`}>
        {TONES.map(({ tone, opacity, d }) => (
          <Path key={tone} d={d} fill={color} fillOpacity={opacity} />
        ))}
      </Svg>
      <Animated.View
        pointerEvents="none"
        style={[{ position: 'absolute', left: 0, top: 0, width: cell, height: cell, backgroundColor: color }, petalStyle]}
      />
    </View>
  );
}
