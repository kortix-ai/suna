'use client';

// PROTOTYPE (/debug/pillar-icons): while its card is hovered, a pillar icon
// fills with a live, multi-colour dithered gradient. A domain-warped fbm field
// runs through a 4-stop colour ramp, and an 8×8 Bayer matrix dithers between
// neighbouring stops, so the colour bands read as pixels, not a smooth blend.
// The field leans toward the cursor and swirls under it. Each pillar adds its
// own motion on top (ripples, caret sweep, rising fill, stroke wipe). At rest
// the icon is the plain Phosphor glyph. Not wired into PillarsBand.

import type { Icon as PhosphorIcon, IconWeight } from '@phosphor-icons/react';
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

export type DitherMode = 'users' | 'code' | 'shield' | 'check';
export type DitherSurface = 'glyph' | 'tile';
const MODE_INDEX: Record<DitherMode, number> = { users: 0, code: 1, shield: 2, check: 3 };

const VERTEX = `
  attribute vec2 position;
  void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;

const FRAGMENT = `
  precision highp float;
  uniform vec2 resolution;
  uniform float time;
  uniform float amount;
  uniform float mode;
  uniform float pixel;
  uniform vec2 pointer;     // cursor in icon uv (y up); may sit far outside 0–1
  uniform float pointerOn;  // 0–1, eased
  uniform vec3 rest;
  uniform vec3 c0;
  uniform vec3 c1;
  uniform vec3 c2;
  uniform vec3 c3;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0; float a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + vec2(4.1, 1.7); a *= 0.5; }
    return v;
  }
  float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
  float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
  float bayer8(vec2 a) { return bayer4(0.5 * a) * 0.25 + bayer2(a); }

  vec3 stop(float i) {
    if (i < 0.5) return c0;
    if (i < 1.5) return c1;
    if (i < 2.5) return c2;
    return c3;
  }

  void main() {
    vec2 cell = floor(gl_FragCoord.xy / pixel);
    vec2 uv = (cell + 0.5) * pixel / resolution;
    float t = time;

    // Cursor: the whole field drifts toward it, and swirls where it is close.
    vec2 toP = pointer - uv;
    float near = exp(-dot(toP, toP) * 3.0) * pointerOn;
    vec2 lean = normalize(toP + 1e-4) * 0.35 * pointerOn;
    float ang = near * 2.4;
    vec2 q = uv - pointer;
    q = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * q + pointer;

    // Domain-warped flow: the base the colour ramp reads.
    vec2 p = q * 1.8 - lean - vec2(t * 0.25, t * 0.12);
    vec2 w = vec2(fbm(p + t * 0.3), fbm(p + vec2(5.2, 1.3) - t * 0.2));
    float f = fbm(p + w * 1.6);

    // Each pillar's own motion, layered onto the flow.
    if (mode < 0.5) {
      // Multiplayer: three people, three ripples that interfere.
      float r = 0.0;
      r += sin(distance(uv, vec2(0.22, 0.66)) * 18.0 - t * 4.0);
      r += sin(distance(uv, vec2(0.78, 0.66)) * 18.0 - t * 4.0 - 2.1);
      r += sin(distance(uv, vec2(0.50, 0.40)) * 18.0 - t * 4.0 - 4.2);
      f += r * 0.09;
    } else if (mode < 1.5) {
      // Company as code: a caret sweeps across and shifts the hue behind it.
      float caret = fract(t * 0.4) * 1.6 - 0.3;
      float d = caret - uv.x;
      f += (d > 0.0 ? exp(-d * 3.0) : exp(d * 20.0)) * 0.35;
    } else if (mode < 2.5) {
      // Sovereign: colour climbs from the base, its crest keeps moving.
      float line = 0.1 + 0.08 * sin(uv.x * 8.0 + t * 2.5) + 0.25 * sin(t * 0.9);
      f += smoothstep(line + 0.5, line - 0.2, uv.y) * 0.3;
    } else {
      // Check: a band that runs along the stroke, left to right.
      float head = fract(t * 0.55) * 1.6 - 0.3;
      float g = (uv.x - head) * 5.0;
      f += exp(-g * g) * 0.3;
    }
    f += near * 0.25;

    // f → 4-stop ramp. Bayer picks between the two neighbouring stops.
    float x = clamp((f - 0.2) * 1.9 + 0.15 * sin(t * 0.7), 0.0, 0.999) * 3.0;
    float i = floor(x);
    float th = bayer8(cell);
    vec3 col = stop(i + step(th, fract(x)));

    // Reveal: a dither dissolve from the rest ink to colour.
    float on = step(bayer8(cell + vec2(3.0, 5.0)) + 0.001, amount);
    gl_FragColor = vec4(mix(rest, col, on), 1.0);
  }
`;

/** A CSS color (token or oklch) as 0–1 RGB, resolved the way the page paints it. */
function rgb(color: string): [number, number, number] {
  const probe = document.createElement('canvas').getContext('2d');
  if (!probe) return [0.5, 0.5, 0.5];
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
  return [r / 255, g / 255, b / 255];
}

function token(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#808080';
}

function svgMask(svg: SVGSVGElement | null | undefined) {
  if (!svg) return undefined;
  let markup = svg.outerHTML.replaceAll('currentColor', '#000');
  if (!markup.includes('xmlns=')) markup = markup.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  return `url("data:image/svg+xml,${encodeURIComponent(markup)}")`;
}

export type DitherIconProps = {
  icon: PhosphorIcon;
  mode: DitherMode;
  active: boolean;
  /** Four CSS variable names: the colour ramp, dark to light or any order. */
  palette: [string, string, string, string];
  /** Cursor position in client px, owned by the card; null when outside. */
  pointer?: RefObject<{ x: number; y: number } | null>;
  /** glyph: colour fills the strokes. tile: colour fills a square behind a white glyph. */
  surface?: DitherSurface;
  size?: number;
  weight?: IconWeight;
  /** Glyph weight while active; the mask morphs to it. */
  activeWeight?: IconWeight;
  /** Dither cell in device px. */
  pixel?: number;
  speed?: number;
  enterMs?: number;
  exitMs?: number;
};

export function DitherIcon({
  icon: Icon,
  mode,
  active,
  palette,
  pointer,
  surface = 'glyph',
  size = 24,
  weight = 'regular',
  activeWeight = weight,
  pixel = 1,
  speed = 1,
  enterMs = 360,
  exitMs = 220,
}: DitherIconProps) {
  const wrap = useRef<HTMLSpanElement>(null);
  const maskSource = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [mask, setMask] = useState<string>();
  const gl = useRef<{ draw: (time: number, amount: number, px: number, py: number, pOn: number) => void; setInks: () => void } | null>(null);
  const live = useRef({ active, speed, pixel, palette, enterMs, exitMs, surface });
  useLayoutEffect(() => {
    live.current = { active, speed, pixel, palette, enterMs, exitMs, surface };
  });

  useLayoutEffect(() => {
    if (surface === 'glyph') setMask(svgMask(maskSource.current?.querySelector('svg')));
  }, [Icon, activeWeight, size, surface]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('webgl', { antialias: false });
    if (!canvas || !ctx) return;
    const compile = (type: number, source: string) => {
      const shader = ctx.createShader(type)!;
      ctx.shaderSource(shader, source);
      ctx.compileShader(shader);
      if (!ctx.getShaderParameter(shader, ctx.COMPILE_STATUS)) console.warn(ctx.getShaderInfoLog(shader));
      return shader;
    };
    const program = ctx.createProgram()!;
    ctx.attachShader(program, compile(ctx.VERTEX_SHADER, VERTEX));
    ctx.attachShader(program, compile(ctx.FRAGMENT_SHADER, FRAGMENT));
    ctx.linkProgram(program);
    if (!ctx.getProgramParameter(program, ctx.LINK_STATUS)) return;
    ctx.useProgram(program);
    ctx.bindBuffer(ctx.ARRAY_BUFFER, ctx.createBuffer());
    ctx.bufferData(ctx.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), ctx.STATIC_DRAW);
    const position = ctx.getAttribLocation(program, 'position');
    ctx.enableVertexAttribArray(position);
    ctx.vertexAttribPointer(position, 2, ctx.FLOAT, false, 0, 0);
    const u = (name: string) => ctx.getUniformLocation(program, name);
    const uRes = u('resolution'), uTime = u('time'), uAmount = u('amount'), uMode = u('mode');
    const uPixel = u('pixel'), uPointer = u('pointer'), uPointerOn = u('pointerOn'), uRest = u('rest');
    const uStops = [u('c0'), u('c1'), u('c2'), u('c3')];

    const setInks = () => {
      // tile: the rest frame is the page ground, so the tile is invisible until revealed.
      ctx.uniform3f(uRest, ...rgb(token(live.current.surface === 'tile' ? '--background' : '--foreground')));
      live.current.palette.forEach((name, i) => ctx.uniform3f(uStops[i], ...rgb(token(name))));
    };
    const draw = (time: number, amount: number, px: number, py: number, pOn: number) => {
      const dpr = window.devicePixelRatio || 1;
      const dim = Math.round(size * dpr);
      if (canvas.width !== dim) {
        canvas.width = dim;
        canvas.height = dim;
        ctx.viewport(0, 0, dim, dim);
      }
      ctx.uniform2f(uRes, dim, dim);
      ctx.uniform1f(uTime, time);
      ctx.uniform1f(uAmount, amount);
      ctx.uniform1f(uMode, MODE_INDEX[mode]);
      ctx.uniform1f(uPixel, live.current.pixel);
      ctx.uniform2f(uPointer, px, py);
      ctx.uniform1f(uPointerOn, pOn);
      ctx.drawArrays(ctx.TRIANGLES, 0, 3);
    };
    setInks();
    gl.current = { draw, setInks };
    const themeObserver = new MutationObserver(setInks);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    return () => {
      themeObserver.disconnect();
      gl.current = null;
    };
  }, [mode, size]);

  const paletteKey = palette.join(',');
  useEffect(() => gl.current?.setInks(), [paletteKey, surface]);

  // amount eases toward 1 on enter and 0 on exit; time runs from the moment
  // amount left 0. The pointer is smoothed so the field trails the cursor.
  const anim = useRef({ amount: 0, start: 0, frame: 0, last: 0, px: 0.5, py: 0.5, pOn: 0 });
  useEffect(() => {
    const a = anim.current;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const canvas = canvasRef.current;
    const tick = (now: number) => {
      const { active: on, speed: s, enterMs: inMs, exitMs: outMs } = live.current;
      const dt = a.last ? now - a.last : 16;
      a.last = now;
      if (a.amount === 0 && on) a.start = now;
      a.amount = on ? Math.min(1, a.amount + dt / inMs) : Math.max(0, a.amount - dt / outMs);
      const eased = 1 - Math.pow(1 - a.amount, 3);

      const client = pointer?.current;
      const rect = wrap.current?.getBoundingClientRect();
      const k = 1 - Math.exp(-dt / 90);
      if (client && rect) {
        const tx = (client.x - rect.left) / rect.width;
        const ty = 1 - (client.y - rect.top) / rect.height;
        a.px += (tx - a.px) * k;
        a.py += (ty - a.py) * k;
      }
      a.pOn += ((client && !reduced ? 1 : 0) - a.pOn) * k;

      const time = reduced ? 3 : ((now - a.start) / 1000) * s;
      if (canvas) canvas.style.opacity = a.amount > 0 ? '1' : '0';
      if (wrap.current) wrap.current.dataset.lit = a.amount > 0.5 ? 'true' : 'false';
      gl.current?.draw(time, reduced ? (on ? 1 : 0) : eased, a.px, a.py, a.pOn);
      if (on || a.amount > 0) a.frame = requestAnimationFrame(tick);
      else a.last = 0;
    };
    cancelAnimationFrame(a.frame);
    a.last = 0;
    a.frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(a.frame);
  }, [active, pointer]);

  const tile = surface === 'tile';
  const glyph = tile ? Math.round(size * 0.5) : size;
  return (
    <span
      ref={wrap}
      data-lit="false"
      className={'group/dither relative inline-flex shrink-0 items-center justify-center' + (tile ? ' overflow-hidden rounded-md' : '')}
      style={{ width: size, height: size }}
    >
      <canvas
        ref={canvasRef}
        aria-hidden
        className="pointer-events-none absolute inset-0 block size-full [image-rendering:pixelated]"
        style={{
          opacity: 0,
          ...(tile ? {} : { maskImage: mask, WebkitMaskImage: mask, maskSize: '100% 100%', WebkitMaskSize: '100% 100%' }),
        }}
      />
      {tile ? (
        <Icon
          size={glyph}
          weight={active ? activeWeight : weight}
          className="text-foreground group-data-[lit=true]/dither:text-background duration-normal relative block transition-colors ease-out"
          aria-hidden
        />
      ) : (
        <>
          {/* The glyph shows only at rest; the canvas covers it while lit. */}
          <Icon size={glyph} weight={weight} className="text-foreground block group-data-[lit=true]/dither:opacity-0" aria-hidden />
          <span ref={maskSource} className="hidden" aria-hidden>
            <Icon size={glyph} weight={activeWeight} />
          </span>
        </>
      )}
    </span>
  );
}
