'use client';

import { motion, useMotionValue, useTransform } from 'framer-motion';
import type { TargetAndTransition } from 'framer-motion';
import { useEffect, useState, useId, useMemo } from 'react';

type Tone = 'light' | 'medium' | 'dark';

const LeftArc = ({
    size,
    tone,
    opacity,
    style,
    className,
    blurAmount,
}: {
    size: number;
    tone: Tone;
    opacity: number; // 0.22–0.38
    style?: React.CSSProperties;
    className?: string;
    blurAmount?: number;
}) => {
    const uid = useId();
    const sw = 542;
    const sh = 520;

    const { c1, c2, c3 } =
        {
            light: { c1: '#D9D9D9', c2: '#DEDEDE', c3: '#3B3B3B' },
            medium: { c1: '#C9C9C9', c2: '#D4D4D4', c3: '#2F2F2F' },
            dark: { c1: '#B9B9B9', c2: '#C8C8C8', c3: '#232323' },
        }[tone];

    const d =
        'M541.499 151.597C249.646 151.597 13.0527 388.191 13.0527 680.043H-138.506C-138.506 304.487 165.943 0.0385742 541.499 0.0385742V151.597Z';

    return (
        <svg
            width={size}
            height={size * (sh / sw)}
            viewBox="-50 -50 642 620"
            fill="none"
            className={className}
            style={{
                overflow: 'visible',
                willChange: 'transform',
                transform: 'translate3d(0, 0, 0)',
                ...style
            }}
        >
            <defs>
                <linearGradient id={`L0_${tone}_${uid}`} x1="201.497" y1="0.0386" x2="201.497" y2="680.043" gradientUnits="userSpaceOnUse">
                    <stop stopColor={c1} />
                    <stop offset="1" stopOpacity="0" />
                </linearGradient>
                <linearGradient id={`L1_${tone}_${uid}`} x1="541.499" y1="401.469" x2="-138.506" y2="401.469" gradientUnits="userSpaceOnUse">
                    <stop stopColor={c2} />
                    <stop offset="1" stopColor={c3} />
                </linearGradient>

                <filter id={`Ledge_${uid}`} x="-50%" y="-50%" width="200%" height="200%">
                    <feGaussianBlur stdDeviation="3" />
                </filter>

                <mask id={`Lmask_${uid}`} maskUnits="userSpaceOnUse">
                    <g filter={`url(#Ledge_${uid})`}>
                        <path d={d} fill="#fff" />
                    </g>
                </mask>

                <pattern id={`Lgrain_${uid}`} patternUnits="userSpaceOnUse" width="100" height="100">
                    <image href="/grain-texture.png" x="0" y="0" width="100" height="100" preserveAspectRatio="none" />
                </pattern>
            </defs>

            <g opacity={opacity}>
                <g style={{ filter: blurAmount && blurAmount > 0 ? `blur(${blurAmount}px)` : undefined }}>
                    <path d={d} fill={`url(#L0_${tone}_${uid})`} />
                    <path d={d} fill={`url(#L1_${tone}_${uid})`} />
                </g>

                <g mask={`url(#Lmask_${uid})`} style={{ mixBlendMode: 'overlay' }} opacity={0.6} pointerEvents="none">
                    <rect x="0" y="0" width="120%" height="120%" fill={`url(#Lgrain_${uid})`} />
                </g>
            </g>
        </svg>
    );
};

const RightArc = ({
    size,
    tone,
    opacity,
    style,
    className,
    blurAmount,
}: {
    size: number;
    tone: Tone;
    opacity: number; // 0.22–0.38
    style?: React.CSSProperties;
    className?: string;
    blurAmount?: number;
}) => {
    const uid = useId();
    const sw = 532;
    const sh = 657;
    const c = { light: '#D9D9D9', medium: '#C9C9C9', dark: '#B9B9B9' }[tone];

    const d =
        'M3.50098 155.457C378.985 155.457 683.375 459.847 683.375 835.331H834.934C834.934 376.144 462.688 3.89844 3.50098 3.89844V155.457Z';

    return (
        <svg
            width={size}
            height={size * (sh / sw)}
            viewBox="-50 -50 632 757"
            fill="none"
            className={className}
            style={{
                overflow: 'visible',
                willChange: 'transform',
                transform: 'translate3d(0, 0, 0)',
                ...style
            }}
        >
            <defs>
                <linearGradient id={`R0_${tone}_${uid}`} x1="419.217" y1="3.89844" x2="419.217" y2="835.331" gradientUnits="userSpaceOnUse">
                    <stop stopColor={c} />
                    <stop offset="1" stopOpacity="0" />
                </linearGradient>

                <filter id={`Redge_${uid}`} x="-50%" y="-50%" width="200%" height="200%">
                    <feGaussianBlur stdDeviation="3" />
                </filter>

                <mask id={`Rmask_${uid}`} maskUnits="userSpaceOnUse">
                    <g filter={`url(#Redge_${uid})`}>
                        <path d={d} fill="#fff" />
                    </g>
                </mask>

                <pattern id={`Rgrain_${uid}`} patternUnits="userSpaceOnUse" width="100" height="100">
                    <image href="/grain-texture.png" x="0" y="0" width="100" height="100" preserveAspectRatio="none" />
                </pattern>
            </defs>

            <g opacity={opacity}>
                <g style={{ filter: blurAmount && blurAmount > 0 ? `blur(${blurAmount}px)` : undefined }}>
                    <path d={d} fill={`url(#R0_${tone}_${uid})`} />
                </g>

                <g mask={`url(#Rmask_${uid})`} style={{ mixBlendMode: 'overlay' }} opacity={0.6} pointerEvents="none">
                    <rect x="0" y="0" width="120%" height="120%" fill={`url(#Rgrain_${uid})`} />
                </g>
            </g>
        </svg>
    );
};

type ArcCfg = {
    pos: { left?: number; right?: number; top: number };
    size: number;
    tone: Tone;
    opacity: number; // 0.22–0.38
    delay: number;
    x: number[];
    y: number[];
    scale: number[];
    blur: string[]; // DOF: more blur when smaller
};

const Arc = ({ left, cfg }: { left?: boolean; cfg: ArcCfg }) => {
    const stylePos: React.CSSProperties = {
        left: cfg.pos.left,
        right: cfg.pos.right,
        top: cfg.pos.top,
        willChange: 'transform',
        transform: 'translate3d(0, 0, 0)',
        backfaceVisibility: 'hidden',
        WebkitBackfaceVisibility: 'hidden',
    };

    // Convert blur strings to numbers for Safari compatibility
    const blurValues = useMemo(() => cfg.blur.map(b => parseFloat(b)), [cfg.blur]);

    // Use motion value for better performance (no re-renders)
    const animationProgress = useMotionValue(0);

    // Transform animation progress to blur value
    const blurAmount = useTransform(animationProgress, [0, 0.33, 0.66, 1], [
        blurValues[0],
        blurValues[1],
        blurValues[2],
        blurValues[0]
    ]);

    const [currentBlur, setCurrentBlur] = useState(blurValues[0]);

    useEffect(() => {
        // Only update blur at most 30 times per second (throttled) for better performance
        let lastUpdate = 0;
        const unsubscribe = blurAmount.on('change', (latest) => {
            const now = Date.now();
            if (now - lastUpdate > 33) { // ~30fps max
                setCurrentBlur(latest);
                lastUpdate = now;
            }
        });
        return unsubscribe;
    }, [blurAmount]);

    return (
        <motion.div
            className="absolute"
            style={stylePos}
            initial={{ x: 0, y: 0, scale: cfg.scale[0] }}
            animate={{
                x: cfg.x,
                y: cfg.y,
                scale: cfg.scale
            }}
            transition={{
                duration: 4.6,
                delay: cfg.delay,
                ease: [0.85, 0, 0.06, 1.01],
                repeat: Infinity,
                repeatType: 'loop',
                times: [0, 0.33, 0.66, 1]
            }}
            onUpdate={(latest) => {
                // Update animation progress for blur interpolation
                const startTime = cfg.delay * 1000;
                const elapsed = (Date.now() - startTime) % 4600;
                animationProgress.set(elapsed / 4600);
            }}
        >
            {left ? (
                <LeftArc size={cfg.size} tone={cfg.tone} opacity={cfg.opacity} blurAmount={currentBlur} />
            ) : (
                <RightArc size={cfg.size} tone={cfg.tone} opacity={cfg.opacity} blurAmount={currentBlur} />
            )}
        </motion.div>
    );
};

interface AnimatedBgProps {
    variant?: 'hero' | 'header';
    blurMultiplier?: number; // 0.5 = half blur, 2 = double blur
    sizeMultiplier?: number; // 0.8 = 80% size, 1.5 = 150% size
    customArcs?: {
        left?: Partial<ArcCfg>[];
        right?: Partial<ArcCfg>[];
    };
}

export function AnimatedBg({ variant = 'hero', blurMultiplier = 1, sizeMultiplier = 1, customArcs }: AnimatedBgProps) {
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);
    if (!mounted) return null;

    // Helper function to apply blur multiplier
    const adjustBlur = (blurValues: string[]): string[] => {
        return blurValues.map(blur => {
            const value = parseFloat(blur);
            return `${value * blurMultiplier}px`;
        });
    };

    // Helper function to apply size multiplier
    const adjustSize = (size: number): number => {
        return Math.round(size * sizeMultiplier);
    };

    // Hero variant - original full-page configuration
    const heroLeft: ArcCfg[] = [
        {
            pos: { left: -190, top: 20 },
            size: 400,
            tone: 'light',
            opacity: 0.1,
            delay: 0.02,
            x: [0, 20, -10, 0],
            y: [0, 15, -8, 0],
            scale: [0.78, 1.1, 0.9, 0.78],
            blur: ['19px', '500px', '50px', '500px'],
        },
        {
            pos: { left: -60, top: 240 },
            size: 600,
            tone: 'dark',
            opacity: 0.22,
            delay: 1.1,
            x: [0, 22, -14, 0],
            y: [0, 16, -12, 0],
            scale: [0.82, 1.15, 0.95, 0.82],
            blur: ['1px', '0px', '0', '1px'],
        },
    ];

    const heroRight: ArcCfg[] = [
        {
            pos: { right: -85, top: 100 },
            size: 620,
            tone: 'dark',
            opacity: 0.23,
            delay: 1.5,
            x: [0, -25, 15, 0],
            y: [0, 18, -12, 0],
            scale: [0.84, 1.2, 1.0, 0.84],
            blur: ['1px', '0px', '0px', '1px'],
        },
        {
            pos: { right: -0, top: 570 },
            size: 220,
            tone: 'light',
            opacity: 0.08,
            delay: 0.3,
            x: [0, -20, 10, 0],
            y: [0, 15, -8, 0],
            scale: [0.8, 1.1, 0.9, 0.8],
            blur: ['500px', '500px', '500px', '500px'],
        },
    ];

    // Header variant - optimized for smaller page header component
    const headerLeft: ArcCfg[] = [
        {
            pos: { left: -150, top: -50 },
            size: adjustSize(450),
            tone: 'light',
            opacity: 0.2,
            delay: 0.02,
            x: [0, 15, -8, 0],
            y: [0, 10, -5, 0],
            scale: [0.85, 1.05, 0.95, 0.85],
            blur: adjustBlur(['12px', '18px', '15px', '12px']),
        },
        {
            pos: { left: -40, top: 100 },
            size: adjustSize(520),
            tone: 'medium',
            opacity: 0.25,
            delay: 0.8,
            x: [0, 18, -10, 0],
            y: [0, 12, -8, 0],
            scale: [0.88, 1.12, 0.98, 0.88],
            blur: adjustBlur(['8px', '4px', '6px', '8px']),
        },
    ];

    const headerRight: ArcCfg[] = [
        {
            pos: { right: -140, top: -50 },
            size: adjustSize(550),
            tone: 'dark',
            opacity: 0.28,
            delay: 1.2,
            x: [0, -20, 12, 0],
            y: [0, 14, -9, 0],
            scale: [0.9, 1.15, 1.0, 0.9],
            blur: adjustBlur(['10px', '4px', '7px', '10px']),
        },
        {
            pos: { right: 300, top: 140 },
            size: adjustSize(280),
            tone: 'light',
            opacity: 0.18,
            delay: 0.4,
            x: [0, -15, 8, 0],
            y: [0, 10, -6, 0],
            scale: [0.92, 1.08, 0.98, 0.92],
            blur: adjustBlur(['20px', '28px', '24px', '20px']),
        },
    ];

    // Helper function to merge custom arcs with defaults
    const mergeArcs = (defaultArcs: ArcCfg[], customArcs?: Partial<ArcCfg>[]): ArcCfg[] => {
        if (!customArcs || customArcs.length === 0) return defaultArcs;

        return customArcs.map((customArc, i) => {
            const defaultArc = defaultArcs[i] || defaultArcs[0];
            return {
                pos: customArc.pos || defaultArc.pos,
                size: customArc.size || defaultArc.size,
                tone: customArc.tone || defaultArc.tone,
                opacity: customArc.opacity !== undefined ? customArc.opacity : defaultArc.opacity,
                delay: customArc.delay !== undefined ? customArc.delay : defaultArc.delay,
                x: customArc.x || defaultArc.x,
                y: customArc.y || defaultArc.y,
                scale: customArc.scale || defaultArc.scale,
                blur: customArc.blur || defaultArc.blur,
            } as ArcCfg;
        });
    };

    const baseLeft = variant === 'header' ? headerLeft : heroLeft;
    const baseRight = variant === 'header' ? headerRight : heroRight;

    const left = customArcs?.left ? mergeArcs(baseLeft, customArcs.left) : baseLeft;
    const right = customArcs?.right ? mergeArcs(baseRight, customArcs.right) : baseRight;

    return (
        <div
            className={`absolute inset-0 overflow-hidden pointer-events-none ${variant === 'header' ? 'z-0' : '-z-10'}`}
            style={{
                transform: 'translateZ(0)',
                WebkitTransform: 'translateZ(0)',
            }}
        >
            <div className="absolute inset-0">
                {left.map((cfg, i) => (
                    <Arc key={`L${i}`} left cfg={cfg} />
                ))}
                {right.map((cfg, i) => (
                    <Arc key={`R${i}`} cfg={cfg} />
                ))}
            </div>
            {/* Bottom gradient fade overlay */}
            {variant === 'hero' && (
                <div className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-background to-transparent pointer-events-none" />
            )}
        </div>
    );
}

