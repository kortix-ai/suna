/**
 * Tells a `Button` that it sits on iOS 26 Liquid Glass (`GlassButtons` in
 * `liquid-glass.tsx`). Pure (no native import), so `Button` and bun tests load
 * it without `expo-glass-effect`.
 *
 * The value draws the button's content: it wraps the children in the glass,
 * or returns them unchanged when a shared glass capsule already sits around
 * the group. `null`: not on glass.
 */
import * as React from 'react';

/** `size`: the `Button` size (`icon*` sizes have a fixed box). */
export type GlassButtonContent = (children: React.ReactNode, size: string | null | undefined) => React.ReactNode;

export const GlassButtonContext = React.createContext<GlassButtonContent | null>(null);
