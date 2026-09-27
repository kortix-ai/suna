/**
 * MetalKortixLogo — the Kortix symbol as a shader that answers the phone's
 * movement (Jay, 2026-09-21). Two styles (`lib/effects/logo-style`), one per
 * Paper shader ported to SkSL and drawn by Skia, so one code path serves iOS
 * and Android (Paper's own build is WebGL and cannot run in React Native):
 *  - `dither`: `lib/effects/dithering-sksl.ts`, the default. A lit sphere
 *    through the symbol's silhouette in Bayer-dithered cells.
 *  - `heatmap`: `lib/effects/heatmap-sksl.ts`. Dark is Paper's design exactly
 *    as exported (contour 1, inner glow 0.89, white and near-black,
 *    transparent back). Light is its own palette on the same shader, because
 *    Paper's white vanishes on a white page.
 *
 * A third style, liquid metal (Paper's LiquidMetal), shipped briefly on
 * 2026-09-22 and was removed the same day (Jay: keep only heatmap and
 * dither). `lib/effects/liquid-metal-sksl.ts` is gone; the mask texture it
 * shared with the dither (`assets/brand/kortix-liquid-metal.png`) stays,
 * because the dither still reads its alpha plane.
 *
 * Both styles read the same tilt (`useTiltMotion`): a move sweeps the
 * shader's time from Paper's rest frame, the direction of the move turns its
 * angle. A still phone shows the rest frame; nothing draws at rest.
 *
 * The layout box is `size` x `size`, the same as `KortixLogo`, which draws the
 * 30 x 25 symbol at full width, centred vertically; the shaders place the
 * symbol in that same box. The heatmap's canvas is larger and centred on the
 * box, for the halo baked into its texture. Until the texture and shader are
 * ready, or if the device cannot compile the shader, the flat `KortixLogo`
 * renders in the same box.
 *
 * Reduce Motion, an unfocused screen and a backgrounded app draw the rest
 * frame and slow the sensor to 1 Hz.
 *
 * **Switching `style` crossfades** (Jay, 2026-09-22): a change of style would
 * otherwise cut instantly, because each style is a different shader over a
 * different texture — there is no shared uniform to animate between them. The
 * exported `MetalKortixLogo` keeps the outgoing style mounted as
 * `SingleStyleLogo`, stacked under the incoming one, and fades one out while
 * the other fades in over `LOGO_STYLE_CROSSFADE_MS`; the outgoing layer then
 * unmounts. Both shaders draw for that one crossfade only.
 */
import * as React from 'react';
import { AccessibilityInfo, AppState, StyleSheet, View } from 'react-native';
import {
  Canvas,
  FilterMode,
  Fill,
  ImageShader,
  MipmapMode,
  Shader,
  Skia,
  useImage,
} from '@shopify/react-native-skia';
import { useIsFocused } from 'expo-router';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { KortixLogo } from '@/components/kortix/KortixLogo';
import { useTiltMotion } from '@/hooks/useTiltMotion';
import {
  DITHERING_PARAMS as D,
  DITHERING_REST_TIME,
  DITHERING_SKSL,
  DITHERING_SWEEP_SECONDS,
  type DitheringUniforms,
} from '@/lib/effects/dithering-sksl';
import {
  HEATMAP_REST_TIME,
  HEATMAP_SKSL,
  HEATMAP_SWEEP_SECONDS,
  PAPER_HEATMAP_PARAMS as P,
  type HeatmapUniforms,
} from '@/lib/effects/heatmap-sksl';
import { SYMBOL_ASPECT } from '@/lib/effects/mark-math';
import { LOGO_STYLE_COLORS, type LogoStyleId } from '@/lib/effects/logo-style';

type Tone = 'light' | 'dark';
type Rgba = [number, number, number, number];

// Paper's `colors[0]` (outline and streaks) and `colors[1]` (body) of the
// heatmap. Fixed brand-metal values, not themed UI surfaces. Dark is Paper's
// export. The shader maps low heat to transparent, so white vanishes on a
// white page and light is designed separately, not inverted.
// hex-allowlist: dark = white #FFFFFF and near-black #242424 (Paper's export); light = near-black #242424 and light gray #E6E6E6
const HEATMAP_PALETTE: Record<Tone, { first: Rgba; second: Rgba }> = {
  dark: { first: [1, 1, 1, 1], second: [0.141, 0.141, 0.141, 1] },
  light: { first: [0.141, 0.141, 0.141, 1], second: [0.9, 0.9, 0.9, 1] },
};
const TRANSPARENT: Rgba = [0, 0, 0, 0];

const HEATMAP_TEXTURE = require('@/assets/brand/kortix-heatmap.png');
const SYMBOL_TEXTURE = require('@/assets/brand/kortix-liquid-metal.png');
const SAMPLING = { filter: FilterMode.Linear, mipmap: MipmapMode.None };

const SKSL: Record<LogoStyleId, string> = {
  heatmap: HEATMAP_SKSL,
  dither: DITHERING_SKSL,
};

interface MetalKortixLogoProps {
  /** Side of the layout box, in points. Same meaning as `KortixLogo.size`. */
  size: number;
  tone: Tone;
  style: LogoStyleId;
  /**
   * The user's colours (`logoPaletteColors`, `lib/effects/logo-palette`) for
   * the heatmap in place of its default metal for `tone`. Null: the default.
   */
  palette?: { first: Rgba; second: Rgba } | null;
  /** The dither's cell colour (`logoFrontColor`). Null: the default for `tone`. */
  front?: Rgba | null;
}

/** How long a style switch takes to crossfade. */
export const LOGO_STYLE_CROSSFADE_MS = 260;

export function MetalKortixLogo(props: MetalKortixLogoProps) {
  const { size, style } = props;
  const [previous, setPrevious] = React.useState<{ style: LogoStyleId; props: MetalKortixLogoProps } | null>(null);
  const fade = useSharedValue(1);
  // Plain refs, not state: they only feed the plain-JS comparison below, and
  // updating them must never itself trigger a render.
  const lastStyleRef = React.useRef(style);
  const lastPropsRef = React.useRef(props);

  // No dependency array: runs after every render, so a style switch is
  // caught even when it lands between unrelated re-renders (a tone flip, a
  // palette change). The ref comparison, not React state, is the source of
  // truth for "did the style just change".
  React.useEffect(() => {
    if (style !== lastStyleRef.current) {
      setPrevious({ style: lastStyleRef.current, props: lastPropsRef.current });
      fade.value = 0;
      fade.value = withTiming(1, { duration: LOGO_STYLE_CROSSFADE_MS }, (finished) => {
        if (finished) runOnJS(setPrevious)(null);
      });
    }
    lastStyleRef.current = style;
    lastPropsRef.current = props;
  });

  const topStyle = useAnimatedStyle(() => ({ opacity: fade.value }));
  const bottomStyle = useAnimatedStyle(() => ({ opacity: 1 - fade.value }));

  if (!previous) return <SingleStyleLogo {...props} />;

  return (
    <View style={{ width: size, height: size, flexShrink: 0 }} pointerEvents="none">
      <Animated.View style={[StyleSheet.absoluteFill, bottomStyle]} pointerEvents="none">
        <SingleStyleLogo {...previous.props} style={previous.style} />
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, topStyle]} pointerEvents="none">
        <SingleStyleLogo {...props} />
      </Animated.View>
    </View>
  );
}

/** The single shader for one style, with the flat fallback while its texture and shader load. */
function SingleStyleLogo({ size, tone, style, palette, front }: MetalKortixLogoProps) {
  const image = useImage(style === 'heatmap' ? HEATMAP_TEXTURE : SYMBOL_TEXTURE);
  const effect = React.useMemo(() => {
    const made = Skia.RuntimeEffect.Make(SKSL[style]);
    if (!made && __DEV__) console.warn(`MetalKortixLogo: the ${style} shader did not compile`);
    return made;
  }, [style]);

  if (!image || !effect) return <KortixLogo size={size} color={tone} />;

  return (
    <ShaderLogo size={size} tone={tone} style={style} palette={palette} front={front} image={image} effect={effect} />
  );
}

type SkiaImage = NonNullable<ReturnType<typeof useImage>>;
type SkiaEffect = NonNullable<ReturnType<typeof Skia.RuntimeEffect.Make>>;

/** The texture and shader are ready: read the tilt and draw the chosen style. */
function ShaderLogo({
  size,
  tone,
  style,
  palette,
  front,
  image,
  effect,
}: MetalKortixLogoProps & { image: SkiaImage; effect: SkiaEffect }) {
  const reduceMotion = useReduceMotion();
  const isFocused = useIsFocused();
  const appActive = useAppActive();
  const running = isFocused && appActive && !reduceMotion;
  const motion = useTiltMotion(running);

  const shared = { size, tone, image, effect, ...motion };
  if (style === 'heatmap') return <HeatmapCanvas {...shared} palette={palette} />;
  return <DitherCanvas {...shared} front={front} />;
}

type CanvasProps = {
  size: number;
  tone: Tone;
  image: SkiaImage;
  effect: SkiaEffect;
  sweep: SharedValue<number>;
  angle: SharedValue<number>;
};

/** The symbol's 30 x 25 box inside the square layout box: full width, centred. */
function symbolBox(size: number): Rgba {
  const height = size / SYMBOL_ASPECT;
  return [0, (size - height) / 2, size, height];
}

function HeatmapCanvas({
  size,
  tone,
  palette,
  image,
  effect,
  sweep,
  angle,
}: CanvasProps & { palette?: { first: Rgba; second: Rgba } | null }) {
  const canvasSize = size / P.scale;
  const colors = palette ?? HEATMAP_PALETTE[tone];
  // Plain numbers, so the worklet below captures no Skia object.
  const imageWidth = image.width();
  const imageHeight = image.height();

  const uniforms = useDerivedValue<HeatmapUniforms>(() => ({
    u_resolution: [canvasSize, canvasSize],
    u_imageSize: [imageWidth, imageHeight],
    u_time: HEATMAP_REST_TIME + sweep.value * HEATMAP_SWEEP_SECONDS,
    u_scale: P.scale,
    u_angle: P.angle + angle.value,
    u_contour: P.contour,
    u_innerGlow: P.innerGlow,
    u_outerGlow: P.outerGlow,
    u_noise: P.noise,
    u_color0: colors.first,
    u_color1: colors.second,
    u_colorBack: TRANSPARENT,
  }));

  const offset = -(canvasSize - size) / 2;
  return (
    <ShaderBox size={size} canvasSize={canvasSize} offset={offset} image={image} effect={effect} uniforms={uniforms} />
  );
}

function DitherCanvas({ size, tone, front, image, effect, sweep, angle }: CanvasProps & { front?: Rgba | null }) {
  const box = symbolBox(size);
  const colorFront: Rgba = front ?? LOGO_STYLE_COLORS[tone].dither.front;
  const imageWidth = image.width();
  const imageHeight = image.height();

  const uniforms = useDerivedValue<DitheringUniforms>(() => ({
    u_imageSize: [imageWidth, imageHeight],
    u_imageBox: box,
    u_resolution: [size, size],
    u_time: DITHERING_REST_TIME + sweep.value * DITHERING_SWEEP_SECONDS,
    u_scale: D.scale,
    u_rotation: D.rotation + angle.value,
    u_pxSize: D.size,
    u_colorBack: TRANSPARENT,
    u_colorFront: colorFront,
    u_shape: D.shape,
    u_type: D.type,
  }));

  return <ShaderBox size={size} canvasSize={size} offset={0} image={image} effect={effect} uniforms={uniforms} />;
}

/** The `size` layout box with a `canvasSize` canvas centred on it, filled by `effect` over the texture. */
function ShaderBox<U extends HeatmapUniforms | DitheringUniforms>({
  size,
  canvasSize,
  offset,
  image,
  effect,
  uniforms,
}: {
  size: number;
  canvasSize: number;
  offset: number;
  image: CanvasProps['image'];
  effect: CanvasProps['effect'];
  uniforms: SharedValue<U>;
}) {
  const imageWidth = image.width();
  const imageHeight = image.height();
  return (
    <View style={{ width: size, height: size, flexShrink: 0 }} pointerEvents="none">
      <Canvas style={{ position: 'absolute', left: offset, top: offset, width: canvasSize, height: canvasSize }}>
        <Fill>
          <Shader source={effect} uniforms={uniforms}>
            <ImageShader
              image={image}
              fit="fill"
              x={0}
              y={0}
              width={imageWidth}
              height={imageHeight}
              tx="clamp"
              ty="clamp"
              sampling={SAMPLING}
            />
          </Shader>
        </Fill>
      </Canvas>
    </View>
  );
}

function useReduceMotion(): boolean {
  const [reduceMotion, setReduceMotion] = React.useState(false);
  React.useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (alive) setReduceMotion(enabled);
    });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return reduceMotion;
}

function useAppActive(): boolean {
  const [active, setActive] = React.useState(AppState.currentState === 'active');
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setActive(s === 'active'));
    return () => sub.remove();
  }, []);
  return active;
}
