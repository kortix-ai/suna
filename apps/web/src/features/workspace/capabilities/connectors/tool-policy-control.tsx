'use client';

import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import Hint from '@/components/ui/hint';
import { cn } from '@/lib/utils';

import type { PolicyChoice } from './tool-policy';

interface PolicySegment {
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
 * FOUR segments, because there are genuinely four states and every one of them
 * has to be reachable. `default` means "no rule of its own — follow the
 * connector default", and selecting it DELETES the tool's exact rule, exactly
 * as the shipped picker's `Default` did (`connectors-view.tsx:3128`). Rendering
 * it as a display-only state would leave a set tool with no way back: pressing
 * a lit segment does not clear it, and the pattern editor never holds a live
 * tool's exact rule. Toggling-off a pressed segment was the alternative and is
 * worse — an undiscoverable interaction is the wrong thing to hide a
 * permissions reset behind.
 *
 * It sits first because it is the state every tool starts in, and because the
 * remaining three then read left-to-right as a trust dial: least on the left,
 * most on the right.
 *
 * Default carries no tint. Inheriting is not a decision, and colouring it
 * would put a fourth hue in every row of a 60-tool connector. The other three
 * reuse the shipped panel's tints (`POLICY_LABEL`,
 * `connectors-view.tsx:2929`), so a reader who has seen the old Permissions tab
 * meets the same colour language here.
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

export interface ToolPolicyControlProps {
  value: PolicyChoice;
  /** Never fires for the already-selected segment — a re-press is not a write. */
  onChange: (choice: PolicyChoice) => void;
  /** Names the group for a screen reader, e.g. `Permission for send_email`. */
  label: string;
  /** A write is in flight, or the caller may not write. */
  disabled?: boolean;
  /** Set when a project rule decides this tool: disables the group and says why. */
  lockedReason?: string;
  /** Shown while `value` is `'default'` — what following the default DOES. */
  defaultHint?: string;
}

/**
 * The per-tool decision: four segments, four states, every one reachable in
 * both directions.
 *
 * `'default'` presses its own segment and a `Hint` names what the default
 * actually does, because "Default" alone does not tell a reader whether the
 * tool runs or asks.
 *
 * `transition-[…,scale]`, not `transition-transform`: Tailwind v4's `scale-*`
 * utility sets the standalone `scale` property, which
 * `transition-property: transform` does not cover — the press would snap. The
 * explicit list also replaces `Button`'s base `transition-all`
 * (`button.tsx:8`), which the polish rules treat as a defect. Same override,
 * same reason, as `project-icon-field.tsx:217`.
 */
export function ToolPolicyControl({
  value,
  onChange,
  label,
  disabled = false,
  lockedReason,
  defaultHint,
}: ToolPolicyControlProps) {
  const locked = Boolean(lockedReason);

  const group = (
    <ButtonGroup aria-label={label} className="shrink-0">
      {POLICY_SEGMENTS.map((segment) => {
        const selected = value === segment.choice;
        return (
          <Button
            key={segment.choice}
            type="button"
            size="sm"
            variant={selected ? 'secondary-outline' : 'outline'}
            aria-pressed={selected}
            disabled={disabled || locked}
            // Re-pressing the current choice is a no-op, not a redundant PUT
            // that rewrites the rule set to what it already is.
            onClick={() => {
              if (!selected) onChange(segment.choice);
            }}
            className={cn(
              'px-2.5 text-xs font-medium',
              'transition-[color,background-color,scale] duration-150 active:scale-[0.96]',
              selected ? segment.tint : cn('text-muted-foreground', segment.hoverTint),
            )}
          >
            {segment.label}
          </Button>
        );
      })}
    </ButtonGroup>
  );

  // A disabled control with no explanation is a dead end. The segments carry
  // `disabled:pointer-events-none`, so the pointer reaches this wrapper and the
  // tooltip still opens on a locked row.
  if (lockedReason) {
    return (
      <Hint label={lockedReason} side="left">
        <div className="shrink-0">{group}</div>
      </Hint>
    );
  }

  if (value === 'default' && defaultHint) {
    return (
      <Hint label={defaultHint} side="left">
        <div className="shrink-0">{group}</div>
      </Hint>
    );
  }

  return group;
}
