'use client';

import type { ConnectorPolicyAction } from '@kortix/sdk';

import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import Hint from '@/components/ui/hint';
import { cn } from '@/lib/utils';

import type { PolicyChoice } from './tool-policy';

interface PolicySegment {
  action: ConnectorPolicyAction;
  label: string;
  /** Applied when the segment is the current choice. */
  tint: string;
  /** Previewed on hover, so an unselected control is not a three-colour smear. */
  hoverTint: string;
}

/**
 * Block · Ask · Allow, in that order — least trust on the left, most on the
 * right, so the row reads as a dial rather than three unrelated buttons.
 *
 * The tints are the ones the shipped panel already uses for these three
 * actions (`POLICY_LABEL`, `connectors-view.tsx:2929`), so a reader who has
 * seen the old Permissions tab meets the same colour language here.
 */
export const POLICY_SEGMENTS: readonly PolicySegment[] = [
  {
    action: 'block',
    label: 'Block',
    tint: 'text-destructive',
    hoverTint: 'hover:text-destructive',
  },
  {
    action: 'require_approval',
    label: 'Ask',
    tint: 'text-kortix-yellow',
    hoverTint: 'hover:text-kortix-yellow',
  },
  {
    action: 'always_run',
    label: 'Allow',
    tint: 'text-kortix-green',
    hoverTint: 'hover:text-kortix-green',
  },
];

export const POLICY_ACTION_LABEL: Record<ConnectorPolicyAction, string> = {
  block: 'Block',
  require_approval: 'Ask',
  always_run: 'Allow',
};

export interface ToolPolicyControlProps {
  /** `'default'` selects NO segment — see the note on the fourth state below. */
  value: PolicyChoice;
  onChange: (action: ConnectorPolicyAction) => void;
  /** Names the group for a screen reader, e.g. `Permission for send_email`. */
  label: string;
  /** A write is in flight, or the caller may not write. */
  disabled?: boolean;
  /** Set when a project rule decides this tool: disables the group and says why. */
  lockedReason?: string;
  /** Shown while `value` is `'default'` — what the platform does instead. */
  defaultHint?: string;
}

/**
 * The per-tool decision: three segments, four states.
 *
 * The fourth state is `'default'`, and it selects nothing. Highlighting Allow
 * for a tool the platform merely allows by default would claim a choice nobody
 * made, and would hide that moving the connector default moves that tool with
 * it. An unlit control plus a `Hint` naming the current default is the honest
 * rendering.
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
        const selected = value === segment.action;
        return (
          <Button
            key={segment.action}
            type="button"
            size="sm"
            variant={selected ? 'secondary-outline' : 'outline'}
            aria-pressed={selected}
            disabled={disabled || locked}
            onClick={() => onChange(segment.action)}
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
