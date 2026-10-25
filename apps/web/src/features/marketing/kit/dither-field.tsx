'use client';

import { cn } from '@kortix/ui';
import { useEffect, useRef } from 'react';

const VERTEX = `
  attribute vec2 position;
  void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;

// Buio's hero orb (DitherOrb.astro): fbm flow, banded light and an 8×8 Bayer
// threshold, minus the sphere. The field fills the whole rectangle; the
// caller's mask decides where it fades.
const FRAGMENT = `
  precision highp float;
  uniform vec2 resolution;
  uniform float time;
  uniform float dpr;
  uniform vec3 ink;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      v += a * noise(p);
      p = p * 2.03 + vec2(4.1, 1.7);
      a *= 0.5;
    }
    return v;
  }
  float bayer2(vec2 a) {
    a = floor(a);
    return fract(a.x / 2.0 + a.y * a.y * 0.75);
  }
  float bayer4(vec2 a) {
    return bayer2(0.5 * a) * 0.25 + bayer2(a);
  }
  float bayer8(vec2 a) {
    return bayer4(0.5 * a) * 0.25 + bayer2(a);
  }

  void main() {
    float pixel = 2.0 * dpr;
    vec2 cell = floor(gl_FragCoord.xy / pixel);
    vec2 p = cell * pixel / resolution.y;
    float t = time * 0.06;

    vec2 surface = vec2(p.x * 1.6 + t, p.y * 2.4);
    float flow = fbm(surface + vec2(fbm(surface * 1.5 + t), 0.0));
    float bands = 0.5 + 0.5 * sin(p.y * 18.0 + flow * 8.0);
    // Light falls from the top edge, where the field meets the section above.
    float light = mix(0.35, 1.0, cell.y * pixel / resolution.y);
    float level = light * mix(0.35, 1.0, bands) * mix(0.6, 1.0, flow);

    float on = step(bayer8(cell) + 0.02, level);
    float alpha = on * 0.55;
    gl_FragColor = vec4(ink * alpha, alpha);
  }
`;

/** The canvas's `color` (a theme token) as 0–1 RGB, via a 1px 2D canvas, so an
 *  oklch() token resolves the same way the page paints it. */
function readInk(canvas: HTMLCanvasElement): [number, number, number] {
  const probe = document.createElement('canvas').getContext('2d');
  if (!probe) return [0.5, 0.5, 0.5];
  probe.fillStyle = getComputedStyle(canvas).color;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
  return [r / 255, g / 255, b / 255];
}

/**
 * A rectangular dither field after Buio's hero (DitherOrb.astro), drawn in the
 * theme's ink (`text-foreground` by default) so it reads in light and dark.
 * WebGL at half resolution, 30fps, paused off screen, one still frame under
 * prefers-reduced-motion. Without WebGL the canvas stays empty.
 */
export function DitherField({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const gl = canvas?.getContext('webgl', { premultipliedAlpha: true, antialias: false });
    if (!canvas || !gl) return;

    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    gl.useProgram(program);

    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const uResolution = gl.getUniformLocation(program, 'resolution');
    const uTime = gl.getUniformLocation(program, 'time');
    const uDpr = gl.getUniformLocation(program, 'dpr');
    const uInk = gl.getUniformLocation(program, 'ink');

    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let visible = false;
    let frame = 0;
    let last = -Infinity;

    const draw = (now: number) => {
      gl.uniform1f(uTime, still ? 4 : now / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    const render = (now: number) => {
      if (now - last >= 33) {
        last = now;
        draw(now);
      }
      if (!still && visible) frame = requestAnimationFrame(render);
    };
    const paint = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(render);
    };

    const setInk = () => {
      gl.uniform3f(uInk, ...readInk(canvas));
      paint();
    };
    const resize = () => {
      const dpr = 0.5;
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uResolution, canvas.width, canvas.height);
      gl.uniform1f(uDpr, dpr);
      paint();
    };

    setInk();
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    // The theme flips a class on <html>: re-read the ink when it does.
    const themeObserver = new MutationObserver(setInk);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    const viewObserver = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) paint();
      else cancelAnimationFrame(frame);
    });
    viewObserver.observe(canvas);

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      themeObserver.disconnect();
      viewObserver.disconnect();
      // No loseContext(): a canvas hands back the same context on the next
      // getContext, so killing it here left Strict Mode's second mount (and any
      // remount) drawing into a dead context. The context goes with the canvas.
    };
  }, []);

  return (
    <canvas
      ref={ref}
      aria-hidden
      className={cn('text-foreground block size-full [image-rendering:pixelated]', className)}
    />
  );
}
