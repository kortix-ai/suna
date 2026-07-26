import type { MessageWithParts } from '@/ui';

/**
 * The contract every chat variant implements.
 *
 * A variant owns ONE question: how much of the agent's work does the transcript
 * show by default, and what shape does the rest fold into? They all read the
 * same `buildActivityItems` model, so a difference between two variants is a
 * design decision, never a data one.
 */
export interface ChatVariantProps {
  messages: MessageWithParts[];
  sessionId: string;
  /** True while the session is still streaming — variants use it to keep the
   *  live burst open and to animate the running row. */
  isBusy?: boolean;
}

export interface ChatVariantDefinition {
  id: string;
  /** Shown on the demo's variant switcher. */
  name: string;
  /** One line: what this variant believes. */
  thesis: string;
  Component: React.ComponentType<ChatVariantProps>;
}
