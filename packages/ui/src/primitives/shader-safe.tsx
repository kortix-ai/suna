'use client';

import { Component, type ReactNode } from 'react';

let webgl2Support: boolean | null = null;

/**
 * One-shot WebGL2 capability probe. Paper Shaders throws at mount when
 * `getContext('webgl2')` returns null, and its ShaderMount calls
 * `getAttribLocation(null, …)` when shader compilation fails silently —
 * both recurring prod errors on GPUs/browsers without (working) WebGL2.
 *
 * `getSupportedExtensions` is a THIRD such null-context crash path: Paper
 * Shaders' shader-mount `useEffect`/rAF callback calls
 * `gl.getSupportedExtensions()` on a context that became `null` after a
 * context-loss / GPU-blacklist event (the probe canvas may return a non-null
 * context at mount that then fails on real use). A throw inside that async
 * callback ESCAPES the `<ShaderSafe>` error boundary (which only catches
 * render-phase throws via `getDerivedStateFromError`) → global error → Sentry
 * → Better Stack (Better Stack pattern `34127fa4…`, call site `new b2` in
 * `app:///_next/static/chunks/c76173f0.…`, prod, 2 occurrences). So the probe
 * must EXERCISE `getSupportedExtensions` itself: if it throws or returns null
 * on the probe canvas, treat WebGL2 as unsupported and fall back BEFORE the
 * throw can happen at render time. The call is cheap and one-shot (memoized).
 */
export function supportsWebGL2(): boolean {
  if (typeof window === 'undefined') return false;
  if (webgl2Support !== null) return webgl2Support;
  try {
    const ctx = document.createElement('canvas').getContext('webgl2');
    if (!ctx) {
      webgl2Support = false;
    } else {
      // Exercise the exact call Paper Shaders makes on the context. A GPU that
      // returns a non-null context but fails on real use (context loss,
      // blacklisted driver, stripped WebView) throws here or returns null —
      // both mean WebGL2 is not usable for decorative shaders, so fall back.
      webgl2Support = ctx.getSupportedExtensions() !== null;
    }
  } catch {
    webgl2Support = false;
  }
  return webgl2Support;
}

/**
 * Test-only escape hatch: clears the one-shot `webgl2Support` memo so each
 * unit test can exercise a fresh probe against a stubbed `document`/`window`.
 * Not imported anywhere in app code.
 */
export function __resetWebGL2ProbeForTests(): void {
  webgl2Support = null;
}

interface ShaderSafeProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ShaderSafeState {
  failed: boolean;
  mounted: boolean;
}

/**
 * Renders shader children only after mount (no SSR/hydration mismatch) and
 * only when WebGL2 works; any runtime shader crash (context loss, compile
 * failure, texture fetch rejection) degrades to the fallback instead of a
 * client-side error. Decorative canvases must never take the page down.
 */
export class ShaderSafe extends Component<ShaderSafeProps, ShaderSafeState> {
  state: ShaderSafeState = { failed: false, mounted: false };

  static getDerivedStateFromError(): Partial<ShaderSafeState> {
    return { failed: true };
  }

  componentDidMount(): void {
    this.setState({ mounted: true });
  }

  render(): ReactNode {
    const { failed, mounted } = this.state;
    if (!mounted || failed || !supportsWebGL2()) return this.props.fallback ?? null;
    return this.props.children;
  }
}
