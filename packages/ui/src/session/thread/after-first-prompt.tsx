'use client';

import { createContext, type ReactNode } from 'react';

/**
 * Drawn under the transcript's first prompt, above its answer: a channel
 * thread's "N replies" divider, so the parent message reads first, then the
 * replies. Only `SessionTurn` reads it, on the first rendered turn.
 */
export const AfterFirstPromptContext = createContext<ReactNode>(null);
