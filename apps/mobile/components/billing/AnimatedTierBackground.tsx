/**
 * Animated Tier Background Component
 * 
 * Premium animated background for Ultra tier card using SVG arcs
 * Ported from frontend with React Native optimizations
 */

import React, { useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import Svg, { Path, Defs, LinearGradient, Stop, Mask, G, Rect } from 'react-native-svg';
import Animated, {
    useSharedValue,
    useAnimatedProps,
    withRepeat,
    withTiming,
    withDelay,
    Easing,
    interpolate,
} from 'react-native-reanimated';

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedG = Animated.createAnimatedComponent(G);

interface ArcProps {
    size: number;
    tone: 'light' | 'medium' | 'dark';
    opacity: number;
    delay: number;
    translateX: number[];
    translateY: number[];
    scale: number[];
    variant: 'left' | 'right';
}

const LeftArc: React.FC<ArcProps> = ({
    size,
    tone,
    opacity,
    delay,
    translateX,
    translateY,
    scale,
}) => {
    const progress = useSharedValue(0);

    useEffect(() => {
        progress.value = withDelay(
            delay * 1000,
            withRepeat(
                withTiming(1, {
                    duration: 8000,
                    easing: Easing.inOut(Easing.ease),
                }),
                -1,
                true
            )
        );
    }, [delay]);

    const animatedProps = useAnimatedProps(() => {
        const currentScale = interpolate(
            progress.value,
            [0, 1],
            [scale[0], scale[1]]
        );
        const currentX = interpolate(
            progress.value,
            [0, 1],
            [translateX[0], translateX[1]]
        );
        const currentY = interpolate(
            progress.value,
            [0, 1],
            [translateY[0], translateY[1]]
        );

        return {
            transform: [
                { translateX: currentX },
                { translateY: currentY },
                { scale: currentScale },
            ],
        };
    });

    const colors = {
        light: { c1: '#D9D9D9', c2: '#DEDEDE', c3: '#3B3B3B' },
        medium: { c1: '#C9C9C9', c2: '#D4D4D4', c3: '#2F2F2F' },
        dark: { c1: '#B9B9B9', c2: '#C8C8C8', c3: '#232323' },
    }[tone];

    const d = "M541.499 151.597C249.646 151.597 13.0527 388.191 13.0527 680.043H-138.506C-138.506 304.487 165.943 0.0385742 541.499 0.0385742V151.597Z";

    return (
        <Svg
            width={size}
            height={size * 0.96}
            viewBox="-50 -50 642 620"
            style={styles.svg}
        >
            <Defs>
                <LinearGradient id={`L0_${tone}`} x1="201.497" y1="0.0386" x2="201.497" y2="680.043">
                    <Stop offset="0" stopColor={colors.c1} />
                    <Stop offset="1" stopColor={colors.c1} stopOpacity="0" />
                </LinearGradient>
                <LinearGradient id={`L1_${tone}`} x1="541.499" y1="401.469" x2="-138.506" y2="401.469">
                    <Stop offset="0" stopColor={colors.c2} />
                    <Stop offset="1" stopColor={colors.c3} />
                </LinearGradient>
                <Mask id={`Lmask_${tone}`}>
                    <Path d={d} fill="#fff" />
                </Mask>
            </Defs>
            <AnimatedG opacity={opacity} animatedProps={animatedProps}>
                <Path d={d} fill={`url(#L0_${tone})`} />
                <Path d={d} fill={`url(#L1_${tone})`} />
            </AnimatedG>
        </Svg>
    );
};

const RightArc: React.FC<ArcProps> = ({
    size,
    tone,
    opacity,
    delay,
    translateX,
    translateY,
    scale,
}) => {
    const progress = useSharedValue(0);

    useEffect(() => {
        progress.value = withDelay(
            delay * 1000,
            withRepeat(
                withTiming(1, {
                    duration: 8000,
                    easing: Easing.inOut(Easing.ease),
                }),
                -1,
                true
            )
        );
    }, [delay]);

    const animatedProps = useAnimatedProps(() => {
        const currentScale = interpolate(
            progress.value,
            [0, 1],
            [scale[0], scale[1]]
        );
        const currentX = interpolate(
            progress.value,
            [0, 1],
            [translateX[0], translateX[1]]
        );
        const currentY = interpolate(
            progress.value,
            [0, 1],
            [translateY[0], translateY[1]]
        );

        return {
            transform: [
                { translateX: currentX },
                { translateY: currentY },
                { scale: currentScale },
            ],
        };
    });

    const color = { light: '#D9D9D9', medium: '#C9C9C9', dark: '#B9B9B9' }[tone];

    const d = "M3.50098 155.457C378.985 155.457 683.375 459.847 683.375 835.331H834.934C834.934 376.144 462.688 3.89844 3.50098 3.89844V155.457Z";

    return (
        <Svg
            width={size}
            height={size * 1.23}
            viewBox="-50 -50 632 757"
            style={styles.svg}
        >
            <Defs>
                <LinearGradient id={`R0_${tone}`} x1="419.217" y1="3.89844" x2="419.217" y2="835.331">
                    <Stop offset="0" stopColor={color} />
                    <Stop offset="1" stopColor={color} stopOpacity="0" />
                </LinearGradient>
                <Mask id={`Rmask_${tone}`}>
                    <Path d={d} fill="#fff" />
                </Mask>
            </Defs>
            <AnimatedG opacity={opacity} animatedProps={animatedProps}>
                <Path d={d} fill={`url(#R0_${tone})`} />
            </AnimatedG>
        </Svg>
    );
};

interface AnimatedTierBackgroundProps {
    variant?: 'ultra' | 'compact';
}

export const AnimatedTierBackground: React.FC<AnimatedTierBackgroundProps> = ({
    variant = 'ultra'
}) => {
    // Ultra variant - simplified for better performance
    const arcs = variant === 'ultra' ? [
        {
            variant: 'left' as const,
            position: { left: -60, top: 20 },
            size: 200,
            tone: 'medium' as const,
            opacity: 0.16,
            delay: 0.2,
            translateX: [0, 10],
            translateY: [0, 8],
            scale: [0.9, 1.05],
        },
        {
            variant: 'right' as const,
            position: { right: -50, top: 100 },
            size: 220,
            tone: 'dark' as const,
            opacity: 0.18,
            delay: 1.5,
            translateX: [0, -12],
            translateY: [0, 10],
            scale: [0.92, 1.08],
        },

    ] : [
        // Compact variant - fewer, subtler arcs
        {
            variant: 'left' as const,
            position: { left: -60, top: 0 },
            size: 180,
            tone: 'medium' as const,
            opacity: 0.18,
            delay: 0.1,
            translateX: [0, 12],
            translateY: [0, 10],
            scale: [0.9, 1.1],
        },
        // {
        //   variant: 'right' as const,
        //   position: { right: -40, top: 80 },
        //   size: 200,
        //   tone: 'dark' as const,
        //   opacity: 0.2,
        //   delay: 0.6,
        //   translateX: [0, -12, 8, 0],
        //   translateY: [0, 10, -6, 0],
        //   scale: [0.9, 1.1, 0.98, 0.9],
        // },
    ];

    return (
        <View style={styles.container} pointerEvents="none">
            {arcs.map((arc, i) => {
                const ArcComponent = arc.variant === 'left' ? LeftArc : RightArc;
                return (
                    <View
                        key={i}
                        style={[
                            styles.arcWrapper,
                            arc.position,
                        ]}
                    >
                        <ArcComponent
                            size={arc.size}
                            tone={arc.tone}
                            opacity={arc.opacity}
                            delay={arc.delay}
                            translateX={arc.translateX}
                            translateY={arc.translateY}
                            scale={arc.scale}
                            variant={arc.variant}
                        />
                    </View>
                );
            })}

        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        overflow: 'hidden',
    },
    arcWrapper: {
        position: 'absolute',
    },
    svg: {
        overflow: 'visible',
    },

});
