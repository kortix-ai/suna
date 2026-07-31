'use client';

import type { ReactNode } from 'react';
import { automations } from './content';
import { Passage } from './passage';

/**
 * Passage 03 — mount directly after the asking interlude, before the
 * open-source section.
 *
 * WHY HERE. The asking interlude's third mode is "Automated — nobody is
 * present", illustrated by a 07:00 report. That is a cron trigger and the
 * interlude never says so. This is the mechanism under exactly that card,
 * one section later.
 *
 * WHY IT IS SAFE NEXT TO AN INTERLUDE. The interlude is a 5/7 two-column
 * section with a bordered panel; this is a single narrow document with a mono
 * rail. Different shape, different weight — they read as a conversation, not as
 * one wall of text.
 *
 * WHY IT IS NOT NEXT TO `channels-section.tsx`. Those two are the pair most at
 * risk of reading as two halves of one chopped-up essay: both answer "where do
 * sessions come from". Keeping the asking interlude between them is deliberate.
 * If the order ever changes, do not let them become adjacent.
 *
 * Copy and its accuracy gate live in `content.ts`. Read that before editing.
 */
export function AutomationsSection(): ReactNode {
  return <Passage passage={automations} />;
}
