'use client';

import { Component, type ReactNode } from 'react';

let webgl2Support: boolean | null = null;

/**
 * One-shot WebGL2 capability probe. Paper Shaders throws at mount when
 * `getContext('webgl2')` returns null, and its ShaderMount calls
 * `getAttribLocation(null, …)` when shader compilation fails silently —
 * both recurring prod errors on GPUs/browsers without (working) WebGL2.
 */
export function supportsWebGL2(): boolean {
  if (typeof window === 'undefined') return false;
  if (webgl2Support !== null) return webgl2Support;
  try {
    webgl2Support = !!document.createElement('canvas').getContext('webgl2');
  } catch {
    webgl2Support = false;
  }
  return webgl2Support;
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
