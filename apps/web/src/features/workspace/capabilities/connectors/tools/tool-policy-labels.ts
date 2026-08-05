import type { PolicyChoice } from './tool-policy';

/**
 * The four permission segments and their labels.
 *
 * A `.ts` sibling of `tool-policy-control.tsx` rather than two more exports on
 * it: React Fast Refresh only hot-swaps a module whose every export is a
 * component, so these constants sitting beside `ToolPolicyControl` made every
 * edit to the control reload the whole page. `rung-permissions.tsx` reads them
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
 * Default · Block · Ask · Allow.
 *
 * FOUR segments, because there are genuinely four states. Default sits first
 * because it is the state every tool starts in, and because the remaining three
 * then read left-to-right as a trust dial: least on the left, most on the right.
 *
 * Default carries no tint. Inheriting is not a decision, and colouring it would
 * put a fourth hue in every row of a 60-tool connector.
 */
export const POLICY_SEGMENTS: readonly PolicySegment[] = [
  {
    choice: 'default',
    label: 'Default',
    tint: 'text-muted-foreground',
    hoverTint: 'hover:text-foreground',
  },
  {
    choice: 'block',
    label: 'Block',
    tint: 'text-destructive',
    hoverTint: 'hover:text-destructive',
  },
  {
    choice: 'require_approval',
    label: 'Ask',
    tint: 'text-kortix-yellow',
    hoverTint: 'hover:text-kortix-yellow',
  },
  {
    choice: 'always_run',
    label: 'Allow',
    tint: 'text-kortix-green',
    hoverTint: 'hover:text-kortix-green',
  },
];

export const POLICY_CHOICE_LABEL: Record<PolicyChoice, string> = {
  default: 'Default',
  block: 'Block',
  require_approval: 'Ask',
  always_run: 'Allow',
};
