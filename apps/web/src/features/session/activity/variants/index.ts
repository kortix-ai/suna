import type { ChatVariantDefinition } from './types';
import { VariantActivityCard } from './variant-activity-card';
import { VariantAdaptive } from './variant-adaptive';
import { VariantGrouped } from './variant-grouped';
import { VariantNarrative } from './variant-narrative';

/**
 * The three explorations, in increasing order of how much they hide by default.
 * The demo at `/design-system/chat` renders all three against one transcript so
 * the choice is made by looking, not by describing.
 */
export const CHAT_VARIANTS: ChatVariantDefinition[] = [
  {
    id: 'grouped',
    name: 'A · Grouped',
    thesis:
      'Keep the step list, fold every run of like work into one human line, never show a raw command at rest.',
    Component: VariantGrouped,
  },
  {
    id: 'activity-card',
    name: 'B · Activity card',
    thesis:
      'Each burst of work between two paragraphs becomes one card with a live status line. The step list lives inside it.',
    Component: VariantActivityCard,
  },
  {
    id: 'narrative',
    name: 'C · Narrative',
    thesis:
      'Only what a non-technical reader would read aloud: the ask, the answer, the deliverable. All machinery is one ghost line.',
    Component: VariantNarrative,
  },
  {
    id: 'adaptive',
    name: 'C + full history',
    thesis:
      'The proposal: C at rest, A on demand. One toggle, same data, re-rendered in place — A is not a rival design, it is C expanded.',
    Component: VariantAdaptive,
  },
];

export type ChatVariantId = (typeof CHAT_VARIANTS)[number]['id'];
export type { ChatVariantDefinition, ChatVariantProps } from './types';
