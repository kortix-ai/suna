'use client';

import { m, useMotionValue, useTransform } from 'motion/react';
import { useEffect, useId, useMemo, useState } from 'react';

type Tone = 'light' | 'medium' | 'dark';

type ArcColor = 'c1' | 'c2' | 'c3';

const ARC_TONES: Record<Tone, Record<ArcColor, string>> = {
  light: { c1: '#D9D9D9', c2: '#DEDEDE', c3: '#3B3B3B' },
  medium: { c1: '#C9C9C9', c2: '#D4D4D4', c3: '#2F2F2F' },
  dark: { c1: '#B9B9B9', c2: '#C8C8C8', c3: '#232323' },
};

type ArcGradient = { box: [number, number, number, number]; from: ArcColor; to?: ArcColor }; // box: x1,y1,x2,y2
type ArcDef = {
  prefix: 'L' | 'R';
  ratio: number; // height / width
  viewBox: string;
  d: string;
  gradients: ArcGradient[];
};

export const LEFT_ARC: ArcDef = {
  prefix: 'L',
  ratio: 520 / 542,
  viewBox: '-50 -50 642 620',
  d: 'M541.499 151.597C249.646 151.597 13.0527 388.191 13.0527 680.043H-138.506C-138.506 304.487 165.943 0.0385742 541.499 0.0385742V151.597Z',
  gradients: [
    { box: [201.497, 0.0386, 201.497, 680.043], from: 'c1' },
    { box: [541.499, 401.469, -138.506, 401.469], from: 'c2', to: 'c3' },
  ],
};

export const RIGHT_ARC: ArcDef = {
  prefix: 'R',
  ratio: 657 / 532,
  viewBox: '-50 -50 632 757',
  d: 'M3.50098 155.457C378.985 155.457 683.375 459.847 683.375 835.331H834.934C834.934 376.144 462.688 3.89844 3.50098 3.89844V155.457Z',
  gradients: [{ box: [419.217, 3.89844, 419.217, 835.331], from: 'c1' }],
};

export const ArcSvg = ({
  cfg,
  size,
  tone,
  opacity,
  style,
  className,
  blurAmount,
}: {
  cfg: ArcDef;
  size: number;
  tone: Tone;
  opacity: number; // 0.22–0.38
  style?: React.CSSProperties;
  className?: string;
  blurAmount?: number;
}) => {
  const uid = useId();
  const colors = ARC_TONES[tone];

  return (
    <svg
      width={size}
      height={size * cfg.ratio}
      viewBox={cfg.viewBox}
      fill="none"
      className={className}
      style={{
        overflow: 'visible',
        transform: 'translate3d(0, 0, 0)',
        ...style,
      }}
    >
      <defs>
        {cfg.gradients.map(({ box, from, to }, i) => (
          <linearGradient
            key={i}
            id={`${cfg.prefix}${i}_${tone}_${uid}`}
            x1={box[0]}
            y1={box[1]}
            x2={box[2]}
            y2={box[3]}
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor={colors[from]} />
            <stop
              offset="1"
              stopColor={to ? colors[to] : undefined}
              stopOpacity={to ? undefined : '0'}
            />
          </linearGradient>
        ))}

        <filter id={`${cfg.prefix}edge_${uid}`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3" />
        </filter>

        <mask id={`${cfg.prefix}mask_${uid}`} maskUnits="userSpaceOnUse">
          <g filter={`url(#${cfg.prefix}edge_${uid})`}>
            <path d={cfg.d} fill="#fff" />
          </g>
        </mask>

        <pattern
          id={`${cfg.prefix}grain_${uid}`}
          patternUnits="userSpaceOnUse"
          width="100"
          height="100"
        >
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
            <path key={i} d={cfg.d} fill={`url(#${cfg.prefix}${i}_${tone}_${uid})`} />
          ))}
        </g>

        <g
          mask={`url(#${cfg.prefix}mask_${uid})`}
          style={{ mixBlendMode: 'overlay' }}
          opacity={0.6}
          pointerEvents="none"
        >
          <rect x="0" y="0" width="120%" height="120%" fill={`url(#${cfg.prefix}grain_${uid})`} />
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
      <ArcSvg
        cfg={left ? LEFT_ARC : RIGHT_ARC}
        size={cfg.size}
        tone={cfg.tone}
        opacity={cfg.opacity}
        blurAmount={currentBlur}
      />
    </m.div>
  );
};

interface AnimatedBgProps {
  /** Animation loop duration in seconds (default 4.6) */
  duration?: number;
}

export function AnimatedBg({ duration = 4.6 }: AnimatedBgProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Show a static placeholder immediately to improve FCP
  // The animated version will replace it after hydration
  if (!mounted) {
    return (
      <div
        className="pointer-events-none absolute inset-0 overflow-hidden -z-10"
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
        <div className="from-background pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t to-transparent" />
      </div>
    );
  }

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

  return (
    <div
      className="pointer-events-none absolute inset-0 overflow-hidden -z-10"
      style={{
        transform: 'translateZ(0)',
        WebkitTransform: 'translateZ(0)',
      }}
    >
      <div className="absolute inset-0">
        {heroLeft.map((cfg, i) => (
          <Arc key={`L${i}`} left cfg={cfg} duration={duration} />
        ))}
        {heroRight.map((cfg, i) => (
          <Arc key={`R${i}`} cfg={cfg} duration={duration} />
        ))}
      </div>
      {/* Bottom gradient fade overlay */}
      <div className="from-background pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t to-transparent" />
    </div>
  );
}
