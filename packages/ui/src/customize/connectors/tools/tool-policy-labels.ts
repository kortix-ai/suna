import type { PolicyChoice } from './tool-policy';

/**
 * The four permission segments and their labels.
 *
 * A `.ts` sibling of `tool-policy-control.tsx` rather than two more exports on
 * it: React Fast Refresh only hot-swaps a module whose every export is a
 * component, so these constants sitting beside `ToolPolicyControl` made every
 * edit to the control reload the whole page. `connector-tools.tsx` reads them
 * too, and now does so without pulling the control's component graph.
 */

export interface PolicySegment {
  choice: PolicyChoice;
  label: string;
  /** Applied when the segment is the current choice. */
  tint: string;
  /** Previewed on hover, so an unselected control is not a four-colour smear. */
  hoverTint: string;
}

/**
 * Default · Allow · Ask · Block.
 *
 * FOUR segments, because there are genuinely four states. Default sits first
 * because it is the state every tool starts in; the control labels it with
 * what it resolves to ("Default · runs").
 *
 * Only Block carries a hue, the destructive token. Allow and Ask are plain
 * ink: a 60-tool list in three status colours reads as noise, and the word
 * already says the decision.
 */
export const POLICY_SEGMENTS: readonly PolicySegment[] = [
  {
    choice: 'default',
    label: 'Default',
    tint: 'text-foreground',
    hoverTint: 'hover:text-foreground',
  },
  {
    choice: 'always_run',
    label: 'Allow',
    tint: 'text-foreground',
    hoverTint: 'hover:text-foreground',
  },
  {
    choice: 'require_approval',
    label: 'Ask',
    tint: 'text-foreground',
    hoverTint: 'hover:text-foreground',
  },
  {
    choice: 'block',
    label: 'Block',
    tint: 'text-destructive',
    hoverTint: 'hover:text-destructive',
  },
];

export const POLICY_CHOICE_LABEL: Record<PolicyChoice, string> = {
  default: 'Default',
  block: 'Block',
  require_approval: 'Ask',
  always_run: 'Allow',
};
