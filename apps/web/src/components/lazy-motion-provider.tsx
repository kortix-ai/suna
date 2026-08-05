'use client';

import { LazyMotion } from 'motion/react';
import { ReactNode } from 'react';

// Loaded via a dynamic import of a dedicated single-export module (see
// lib/motion/dom-animation.ts) rather than `import('motion/react')` directly.
// `m`/`AnimatePresence`/`MotionConfig` are already imported statically
// elsewhere in the app; dynamically importing the same barrel module would
// not split anything out of the initial bundle. A standalone module whose
// only export is `domAnimation` is what lets the bundler carve the
// animation/gesture engine into its own chunk.
const loadDomAnimationFeatures = () =>
  import('@/lib/motion/dom-animation').then((mod) => mod.domAnimation);

/**
 * App-wide `LazyMotion` boundary. Every `motion/react` import in the app was
 * converted from eager `motion.*` components to `m.*`, which defers the
 * animation/gesture engine into an async chunk instead of the initial JS
 * payload. This must wrap the whole app (mounted near the root of
 * `app/layout.tsx`) since `m.*` components render across every route group
 * — marketing, auth, and the dashboard/session shell alike.
 *
 * Loads `domAnimation` only: covers plain animations, hover/tap/focus/
 * viewport gestures, and `AnimatePresence` exit animations (including
 * `mode="popLayout"`, which is a DOM/CSS trick and does not need the layout
 * engine). It does NOT include `layout`/`layoutId`/`drag` — as of this
 * writing the only site using those is
 * `features/review-center/review-center.tsx`, which opens its own nested
 * `domMax` boundary locally instead of paying for the layout engine here.
 * If a future `layout`/`layoutId`/`drag` prop is added elsewhere, either move
 * it under a `domMax` boundary too, or promote this provider to `domMax` if
 * usage becomes widespread.
 */
export function LazyMotionProvider({ children }: { children: ReactNode }) {
  return <LazyMotion features={loadDomAnimationFeatures}>{children}</LazyMotion>;
}
