'use client';

import type { ReactNode } from 'react';
import { channels } from './content';
import { Passage } from './passage';

/**
 * Passage 02 — mount directly after the use-case wheel, before the asking
 * interlude.
 *
 * WHY HERE. The wheel is ten finished artifacts and shows no one asking for any
 * of them. This is where the ask arrives, and it earns the phrase the asking
 * interlude opens with one section later ("in a Slack thread, on the web, or
 * from the CLI") instead of leaving it as an assertion.
 *
 * WHY IT MATTERS THAT IT IS EARLY. A reader who is told nothing assumes the
 * channel list is long. Naming the closed enum here — Slack live, Teams behind
 * an operator switch, email and voice experimental — is the honest version and
 * it is better delivered before someone goes looking for WhatsApp.
 *
 * Copy and its accuracy gate live in `content.ts`. Read that before editing.
 */
export function ChannelsSection(): ReactNode {
  return <Passage passage={channels} />;
}
