'use client';

import * as React from 'react';
import { Avatar, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';

const SIZE_CLASS = {
  xs: 'size-5',
  sm: 'size-6',
  md: 'size-8',
  lg: 'size-10',
  xl: 'size-14',
} as const;

const SIZE_PX = {
  xs: 20,
  sm: 24,
  md: 32,
  lg: 40,
  xl: 56,
} as const;

export type UserAvatarSize = keyof typeof SIZE_CLASS;

export interface UserAvatarProps {
  email: string;
  name?: string | null;
  avatarUrl?: string | null;
  size?: UserAvatarSize;
  className?: string;
  ring?: boolean;
}

const PALETTES: ReadonlyArray<ReadonlyArray<[number, number, number]>> = [
  [
    [190, 60, 35],
    [270, 50, 65],
    [25, 60, 76],
  ],
  [
    [310, 55, 35],
    [10, 65, 60],
    [45, 60, 80],
  ],
  [
    [220, 60, 30],
    [180, 55, 70],
    [40, 40, 85],
  ],
  [
    [140, 55, 32],
    [15, 60, 55],
    [50, 55, 80],
  ],
  [
    [250, 55, 35],
    [320, 45, 60],
    [350, 55, 82],
  ],
  [
    [185, 55, 35],
    [75, 50, 50],
    [40, 50, 80],
  ],
  [
    [340, 60, 32],
    [350, 65, 62],
    [30, 60, 80],
  ],
  [
    [175, 55, 32],
    [25, 55, 50],
    [45, 60, 78],
  ],
  [
    [220, 35, 32],
    [20, 60, 65],
    [260, 45, 80],
  ],
  [
    [90, 50, 45],
    [45, 65, 58],
    [55, 60, 82],
  ],
  [
    [5, 60, 48],
    [180, 55, 55],
    [35, 50, 80],
  ],
  [
    [270, 55, 35],
    [320, 60, 60],
    [350, 55, 82],
  ],
];

function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return hash >>> 0;
}

function seededRandom(seed: number): () => number {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

function hslCss(h: number, s: number, l: number): string {
  return `hsl(${h} ${s}% ${l}%)`;
}

export function UserAvatar({
  email,
  name,
  avatarUrl,
  size = 'md',
  className,
  ring = false,
}: UserAvatarProps) {
  const sizeClass = SIZE_CLASS[size];
  const sizePx = SIZE_PX[size];

  if (avatarUrl) {
    return (
      <Avatar
        className={cn(
          sizeClass,
          'shrink-0',
          ring && 'ring-background ring-2',
          className,
        )}
      >
        <AvatarImage src={avatarUrl} alt={name || email} />
      </Avatar>
    );
  }

  return (
    <BlobAvatar
      seed={email || name || 'anon'}
      sizePx={sizePx}
      className={cn(sizeClass, 'shrink-0', ring && 'ring-background ring-2', className)}
    />
  );
}

function BlobAvatar({
  seed: seedSource,
  sizePx,
  className,
}: {
  seed: string;
  sizePx: number;
  className?: string;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const [webglFailed, setWebglFailed] = React.useState(false);

  const config = React.useMemo(() => {
    const seed = hashString(seedSource.toLowerCase().trim());
    const rand = seededRandom(seed);
    const palette = PALETTES[seed % PALETTES.length]!;
    const jitter = (hue: number) => (hue + (rand() - 0.5) * 8 + 360) % 360;
    const triples = [
      [jitter(palette[0]![0]), palette[0]![1], palette[0]![2]] as const,
      [jitter(palette[1]![0]), palette[1]![1], palette[1]![2]] as const,
      [jitter(palette[2]![0]), palette[2]![1], palette[2]![2]] as const,
    ];
    return {
      seed,
      colorsRgb: triples.map(([h, s, l]) => hslToRgb(h, s, l)) as [
        [number, number, number],
        [number, number, number],
        [number, number, number],
      ],
      colorsCss: triples.map(([h, s, l]) => hslCss(h, s, l)) as [string, string, string],
    };
  }, [seedSource]);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl');
    if (!gl) {
      setWebglFailed(true);
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    canvas.width = sizePx * dpr;
    canvas.height = sizePx * dpr;
    gl.viewport(0, 0, canvas.width, canvas.height);

    const vertexShaderSource = `
      attribute vec2 position;
      varying vec2 vUv;
      void main() {
        vUv = position * 0.5 + 0.5;
        gl_Position = vec4(position, 0.0, 1.0);
      }
    `;

    const fragmentShaderSource = `
      precision highp float;
      varying vec2 vUv;
      uniform vec3 color1;
      uniform vec3 color2;
      uniform vec3 color3;
      uniform float seed;

      float blob(vec2 uv, vec2 center, float radius) {
        return radius / distance(uv, center);
      }

      float random(vec2 st) {
        return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
      }

      void main() {
        vec2 uv = vUv;
        vec2 p1 = vec2(0.30 + sin(seed * 0.0007) * 0.18, 0.35 + cos(seed * 0.0009) * 0.18);
        vec2 p2 = vec2(0.75 + cos(seed * 0.0005) * 0.15, 0.40 + sin(seed * 0.0008) * 0.15);
        vec2 p3 = vec2(0.50 + sin(seed * 0.0011) * 0.20, 0.78 + cos(seed * 0.0006) * 0.15);
        float b1 = blob(uv, p1, 0.22);
        float b2 = blob(uv, p2, 0.24);
        float b3 = blob(uv, p3, 0.20);
        vec3 color = color1 * b1 + color2 * b2 + color3 * b3;
        color /= (b1 + b2 + b3);
        color += random(uv + seed) * 0.03;
        gl_FragColor = vec4(color, 1.0);
      }
    `;

    function createShader(type: number, source: string): WebGLShader | null {
      const shader = gl!.createShader(type);
      if (!shader) return null;
      gl!.shaderSource(shader, source);
      gl!.compileShader(shader);
      if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) {
        gl!.deleteShader(shader);
        return null;
      }
      return shader;
    }

    const vertexShader = createShader(gl.VERTEX_SHADER, vertexShaderSource);
    const fragmentShader = createShader(gl.FRAGMENT_SHADER, fragmentShaderSource);
    if (!vertexShader || !fragmentShader) {
      setWebglFailed(true);
      return;
    }

    const program = gl.createProgram();
    if (!program) {
      setWebglFailed(true);
      return;
    }
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      setWebglFailed(true);
      return;
    }
    gl.useProgram(program);

    const vertices = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    const positionLocation = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    const c1 = gl.getUniformLocation(program, 'color1');
    const c2 = gl.getUniformLocation(program, 'color2');
    const c3 = gl.getUniformLocation(program, 'color3');
    const seedLoc = gl.getUniformLocation(program, 'seed');

    const [r1, g1, b1] = config.colorsRgb[0];
    const [r2, g2, b2] = config.colorsRgb[1];
    const [r3, g3, b3] = config.colorsRgb[2];
    gl.uniform3f(c1, r1, g1, b1);
    gl.uniform3f(c2, r2, g2, b2);
    gl.uniform3f(c3, r3, g3, b3);
    gl.uniform1f(seedLoc, config.seed);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    return () => {
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
    };
  }, [config, sizePx]);

  if (webglFailed) {
    const [c1, c2, c3] = config.colorsCss;
    return (
      <div
        className={cn(
          'relative overflow-hidden rounded-full ring-1 ring-white/10',
          className,
        )}
        style={{
          backgroundImage: `radial-gradient(circle at 30% 35%, ${c1}, transparent 60%), radial-gradient(circle at 75% 40%, ${c2}, transparent 60%), radial-gradient(circle at 50% 78%, ${c3}, transparent 65%)`,
          backgroundColor: c2,
        }}
        aria-hidden
      />
    );
  }

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-full ring-1 ring-white/10',
        className,
      )}
      aria-hidden
    >
      <canvas ref={canvasRef} className="h-full w-full" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.18),transparent_60%)]" />
    </div>
  );
}
