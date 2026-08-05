'use client';

import { LazyMotion } from 'motion/react';
import { ReactNode } from 'react';

// Loaded via a dynamic import of a dedicated single-export module (see
// lib/motion/dom-max.ts) rather than `import('motion/react')` directly.
// `m`/`AnimatePresence`/`MotionConfig` are already imported statically
// elsewhere in the app; dynamically importing the same barrel module would
// not split anything out of the initial bundle. A standalone module whose
// only export is `domMax` is what lets the bundler carve the
// animation/gesture/layout engine into its own chunk.
const loadDomMaxFeatures = () => import('@/lib/motion/dom-max').then((mod) => mod.domMax);

/**
 * App-wide `LazyMotion` boundary. Every `motion/react` import in the app was
 * converted from eager `motion.*` components to `m.*`, which defers the
 * animation/gesture/layout engine into an async chunk instead of the initial
 * JS payload. This must wrap the whole app (mounted near the root of
 * `app/layout.tsx`) since `m.*` components render across every route group
 * — marketing, auth, and the dashboard/session shell alike.
 *
 * Loads `domMax`, not `domAnimation`. This app has real `layout` usage (bare
 * boolean shorthand `<m.div layout>`, easy to miss with a naive grep) spread
 * across general-tab.tsx, queued-messages.tsx, step-connectors.tsx,
 * projects-page.tsx, and review-center.tsx — 10 sites total. A single global
 * `LazyMotion` at `domAnimation` plus a second, narrower `domMax` boundary
 * around just the sites that need it was considered and rejected: feature
 * loading in framer-motion is a *global* registry
 * (`setFeatureDefinitions` in motion-dom, called from
 * `motion/features/load-features.mjs`), not scoped by React context — once
 * any `domMax` boundary anywhere in the tree mounts, `layout`/`drag` become
 * available everywhere, including sites nominally left on `domAnimation`.
 * Two boundaries would therefore make layout animation correctness depend on
 * mount/navigation order instead of being deterministic. One boundary at
 * `domMax` is the only sound design; the bundle-size cost is a strictly
 * deferred (non-initial) chunk either way, so it's a fine trade.
 */
export function LazyMotionProvider({ children }: { children: ReactNode }) {
  return <LazyMotion features={loadDomMaxFeatures}>{children}</LazyMotion>;
}
