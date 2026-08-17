'use client';

import { createContext } from 'react';

/**
 * Which surface a tool view is being rendered on.
 *
 * Lives in its own module rather than in `infrastructure.tsx` to keep the
 * import graph acyclic. The shared cards need to know the surface (an inline
 * row indents to its label column; a panel row supplies its own padding), and
 * `infrastructure.tsx` in turn renders those cards — so if the context stayed
 * there, card → infrastructure → card would be a cycle. It survives today only
 * because every use sits inside a component body and therefore runs after all
 * modules have initialized, which is a property no one should have to know.
 */
export type ToolSurface = 'inline' | 'panel';

export const ToolSurfaceContext = createContext<ToolSurface>('inline');
