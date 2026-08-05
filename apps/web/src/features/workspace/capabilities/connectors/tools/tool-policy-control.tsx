'use client';

import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import Hint from '@/components/ui/hint';
import { cn } from '@/lib/utils';

import type { PolicyChoice } from './tool-policy';
import { POLICY_SEGMENTS } from './tool-policy-labels';

// Segment definitions + labels live in `./tool-policy-labels` so this module
// exports only components (React Fast Refresh).



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
      <Hint label={lockedReason} side="bottom">
        <div className="shrink-0">{group}</div>
      </Hint>
    );
  }

  if (value === 'default' && defaultHint) {
    return (
      <Hint label={defaultHint} side="bottom">
        <div className="shrink-0">{group}</div>
      </Hint>
    );
  }

  return group;
}
