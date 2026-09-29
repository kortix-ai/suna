'use client';

import { cn } from '@/lib/utils';
import { m, useMotionValue, useTransform } from 'motion/react';
import { useEffect, useId, useMemo, useState } from 'react';

type Tone = 'light' | 'medium' | 'dark';

type ArcStop = { color?: number; offset?: string; opacity?: string };

// [x1, y1, x2, y2, stops]: one linearGradient per entry, id `${prefix}${i}_${tone}_${uid}`.
type ArcGradient = [x1: string, y1: string, x2: string, y2: string, stops: ArcStop[]];

type ArcSvgCfg = {
  // The svg id prefix ('L'/'R'): every def id and fill url is `${prefix}…`.
  prefix: 'L' | 'R';
  sw: number;
  sh: number;
  d: string;
  gradients: ArcGradient[];
};

// Per-tone gradient stop colors, indexed by ArcStop.color (Right's c = column 0).
const TONE_COLORS: Record<Tone, string[]> = {
  light: ['#D9D9D9', '#DEDEDE', '#3B3B3B'],
  medium: ['#C9C9C9', '#D4D4D4', '#2F2F2F'],
  dark: ['#B9B9B9', '#C8C8C8', '#232323'],
};

type ArcSvgProps = {
  size: number;
  tone: Tone;
  opacity: number; // 0.22–0.38
  style?: React.CSSProperties;
  className?: string;
  blurAmount?: number;
  cfg: ArcSvgCfg;
};

const ArcSvg = ({ size, tone, opacity, style, className, blurAmount, cfg }: ArcSvgProps) => {
  const uid = useId();
  const { d, sw, sh, prefix: p } = cfg;

  return (
    <svg
      width={size}
      height={size * (sh / sw)}
      viewBox={`-50 -50 ${sw + 100} ${sh + 100}`}
      fill="none"
      className={className}
      style={{
        overflow: 'visible',
        transform: 'translate3d(0, 0, 0)',
        ...style,
      }}
    >
      <defs>
        {cfg.gradients.map(([x1, y1, x2, y2, stops], i) => (
          <linearGradient
            // biome-ignore lint/suspicious/noArrayIndexKey: static config, stable order
            key={i}
            id={`${p}${i}_${tone}_${uid}`}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            gradientUnits="userSpaceOnUse"
          >
            {stops.map((s, j) => (
              <stop
                // biome-ignore lint/suspicious/noArrayIndexKey: static config, stable order
                key={j}
                offset={s.offset}
                stopColor={s.color === undefined ? undefined : TONE_COLORS[tone][s.color]}
                stopOpacity={s.opacity}
              />
            ))}
          </linearGradient>
        ))}

        <filter id={`${p}edge_${uid}`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3" />
        </filter>

        <mask id={`${p}mask_${uid}`} maskUnits="userSpaceOnUse">
          <g filter={`url(#${p}edge_${uid})`}>
            <path d={d} fill="#fff" />
          </g>
        </mask>

        <pattern id={`${p}grain_${uid}`} patternUnits="userSpaceOnUse" width="100" height="100">
          <image
            href="/grain-texture.png"
            x="0"
            y="0"
            width="100"
            height="100"
            preserveAspectRatio="none"
          />
        </pattern>
      </defs>

      <g opacity={opacity}>
        <g
          style={{
            filter: blurAmount && blurAmount > 0 ? `blur(${blurAmount}px)` : undefined,
          }}
        >
          {cfg.gradients.map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static config, stable order
            <path key={i} d={d} fill={`url(#${p}${i}_${tone}_${uid})`} />
          ))}
        </g>

        <g
          mask={`url(#${p}mask_${uid})`}
          style={{ mixBlendMode: 'overlay' }}
          opacity={0.6}
          pointerEvents="none"
        >
          <rect x="0" y="0" width="120%" height="120%" fill={`url(#${p}grain_${uid})`} />
        </g>
      </g>
    </svg>
  );
};

const LEFT_CFG: ArcSvgCfg = {
  prefix: 'L',
  sw: 542,
  sh: 520,
  d: 'M541.499 151.597C249.646 151.597 13.0527 388.191 13.0527 680.043H-138.506C-138.506 304.487 165.943 0.0385742 541.499 0.0385742V151.597Z',
  gradients: [
    ['201.497', '0.0386', '201.497', '680.043', [{ color: 0 }, { offset: '1', opacity: '0' }]],
    ['541.499', '401.469', '-138.506', '401.469', [{ color: 1 }, { offset: '1', color: 2 }]],
  ],
};

const RIGHT_CFG: ArcSvgCfg = {
  prefix: 'R',
  sw: 532,
  sh: 657,
  d: 'M3.50098 155.457C378.985 155.457 683.375 459.847 683.375 835.331H834.934C834.934 376.144 462.688 3.89844 3.50098 3.89844V155.457Z',
  gradients: [
    ['419.217', '3.89844', '419.217', '835.331', [{ color: 0 }, { offset: '1', opacity: '0' }]],
  ],
};

export const LeftArc = (props: Omit<ArcSvgProps, 'cfg'>) => <ArcSvg {...props} cfg={LEFT_CFG} />;
export const RightArc = (props: Omit<ArcSvgProps, 'cfg'>) => <ArcSvg {...props} cfg={RIGHT_CFG} />;
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

const Arc = ({ left, cfg, duration = 4.6 }: { left?: boolean; cfg: ArcCfg; duration?: number }) => {
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
  const blurValues = useMemo(() => cfg.blur.map((b) => parseFloat(b)), [cfg.blur]);

  // Use motion value for better performance (no re-renders)
  const animationProgress = useMotionValue(0);

  // Transform animation progress to blur value
  const blurAmount = useTransform(
    animationProgress,
    [0, 0.33, 0.66, 1],
    [blurValues[0], blurValues[1], blurValues[2], blurValues[0]],
  );

  const [currentBlur, setCurrentBlur] = useState(blurValues[0]);

  useEffect(() => {
    // Only update blur at most 30 times per second (throttled) for better performance
    let lastUpdate = 0;
    const unsubscribe = blurAmount.on('change', (latest) => {
      const now = Date.now();
      if (now - lastUpdate > 33) {
        // ~30fps max
        setCurrentBlur(latest);
        lastUpdate = now;
      }
    });
    return unsubscribe;
  }, [blurAmount]);

  return (
    <m.div
      className="absolute"
      style={stylePos}
      initial={{ x: 0, y: 0, scale: cfg.scale[0] }}
      animate={{
        x: cfg.x,
        y: cfg.y,
        scale: cfg.scale,
      }}
      transition={{
        duration,
        delay: cfg.delay,
        ease: [0.85, 0, 0.06, 1.01],
        repeat: Infinity,
        repeatType: 'loop',
        times: [0, 0.33, 0.66, 1],
      }}
      onUpdate={() => {
        // Update animation progress for blur interpolation
        const startTime = cfg.delay * 1000;
        const elapsed = (Date.now() - startTime) % (duration * 1000);
        animationProgress.set(elapsed / (duration * 1000));
      }}
    >
      {left ? (
        <LeftArc size={cfg.size} tone={cfg.tone} opacity={cfg.opacity} blurAmount={currentBlur} />
      ) : (
        <RightArc size={cfg.size} tone={cfg.tone} opacity={cfg.opacity} blurAmount={currentBlur} />
      )}
    </m.div>
  );
};

interface AnimatedBgProps {
  variant?: 'hero' | 'header';
  blurMultiplier?: number; // 0.5 = half blur, 2 = double blur
  sizeMultiplier?: number; // 0.8 = 80% size, 1.5 = 150% size
  /** Animation loop duration in seconds (default 4.6) */
  duration?: number;
  customArcs?: {
    left?: Partial<ArcCfg>[];
    right?: Partial<ArcCfg>[];
  };
}

export function AnimatedBg({
  variant = 'hero',
  blurMultiplier = 1,
  sizeMultiplier = 1,
  duration = 4.6,
  customArcs,
}: AnimatedBgProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Show a static placeholder immediately to improve FCP
  // The animated version will replace it after hydration
  if (!mounted) {
    return (
      <div
        className={cn(
          'pointer-events-none absolute inset-0 overflow-hidden',
          variant === 'header' ? 'z-0' : '-z-10',
        )}
        aria-hidden="true"
      >
        {/* Static gradient placeholder matching the animated bg */}
        <div
          className="absolute inset-0 opacity-20"
          style={{
            background:
              'radial-gradient(ellipse at 20% 30%, rgba(200, 200, 200, 0.15) 0%, transparent 50%), radial-gradient(ellipse at 80% 40%, rgba(180, 180, 180, 0.12) 0%, transparent 45%)',
          }}
        />
        {variant === 'hero' && (
          <div className="from-background pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t to-transparent" />
        )}
      </div>
    );
  }

  // Helper function to apply blur multiplier
  const adjustBlur = (blurValues: string[]): string[] => {
    return blurValues.map((blur) => {
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
      className={cn(
        'pointer-events-none absolute inset-0 overflow-hidden',
        variant === 'header' ? 'z-0' : '-z-10',
      )}
      style={{
        transform: 'translateZ(0)',
        WebkitTransform: 'translateZ(0)',
      }}
    >
      <div className="absolute inset-0">
        {left.map((cfg, i) => (
          <Arc key={`L${i}`} left cfg={cfg} duration={duration} />
        ))}
        {right.map((cfg, i) => (
          <Arc key={`R${i}`} cfg={cfg} duration={duration} />
        ))}
      </div>
      {/* Bottom gradient fade overlay */}
      {variant === 'hero' && (
        <div className="from-background pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t to-transparent" />
      )}
    </div>
  );
}
