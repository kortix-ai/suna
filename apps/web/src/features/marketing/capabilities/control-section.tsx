'use client';

import type { ReactNode } from 'react';
import { control } from './content';
import { Passage } from './passage';

/**
 * Passage 04 — mount directly after the owning interlude, before the trust
 * section.
 *
 * WHY HERE. `how-it-works-content.ts:11-13` says in as many words that
 * "Security and governance is deliberately not a layer here", and the trust
 * section below is badges and pillars, not mechanism. Nothing else on the page
 * explains how an agent is held in bounds. This is the mechanism, mounted so the
 * reader has it before the trust card asks them to believe it.
 *
 * It also finishes the thought the owning interlude starts: that section ends on
 * "reach is declared, never inherited", and this one opens on who a reach is
 * declared FOR. Different register — a two-column panel section, then a narrow
 * document — so the pair reads as a hand-off rather than a wall.
 *
 * THREE PARAGRAPHS, NOT TWO. The other three passages run two. This one carries
 * the secrets correction, which cannot be compressed without becoming the false
 * claim it exists to prevent: a granted runtime secret IS a real env value in
 * the session. Read the accuracy gate in `content.ts` before touching it.
 *
 * DO NOT ADD THE ALLOW / ASK / BLOCK WALKTHROUGH HERE. It was proposed for this
 * section on 2026-07-31 and rejected: the per-action policy material and the
 * connector-permissions capture belong on `/connectors`, high up, where a
 * reader is already thinking about connecting a tool. This section stays prose,
 * and stays quiet.
 */
export function ControlSection(): ReactNode {
  return <Passage passage={control} />;
}
