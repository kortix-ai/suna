'use client';

import type { ReactNode } from 'react';
import { agents } from './content';
import { Passage } from './passage';

/**
 * Passage 01 — mount directly after the layer stack, before the use-case wheel.
 *
 * WHY HERE. The stack's layer 04 says "An OpenCode agent: markdown, plus the
 * tools and plugins beside it", then the stack ends. That card is the smallest
 * true thing you can say about an agent, and the reader leaves the stack holding
 * it. This is the correction, in the one position where the question is still
 * fresh — and it is the only place on the home page the grant surface (the
 * machine it boots, its connectors, its secrets, its skills, its dosco verbs)
 * appears at all.
 *
 * It also has to stand alone: mounted anywhere else, or read on its own, it
 * still opens on what an agent is rather than on what the stack just said.
 *
 * Copy and its accuracy gate live in `content.ts`. Read that before editing.
 */
export function AgentsSection(): ReactNode {
  return <Passage passage={agents} />;
}
