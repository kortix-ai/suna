'use client';

import Hint from '../../../primitives/hint';
import { tabsSegmentedChipClasses, tabsSegmentedTrackClasses } from '../../../primitives/tabs';
import { cn } from '../../../internal/lib/utils';
import { useLocalizedUiCatalog } from '../../../i18n/ui-catalog/use-localized-ui-catalog';

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
  /** Replaces the Default segment's label with what it resolves to: "Default · runs", "Inherit · asks". */
  defaultLabel?: string;
}

/**
 * The per-tool decision: four segments, four states, every one reachable in
 * both directions.
 *
 * It is the segmented track of `Tabs` (`tabs.tsx`): a recessed track and one
 * raised chip, so the choice reads at a glance down a 60-row list. It is not
 * a tablist: each segment is a toggle button with `aria-pressed`.
 *
 * `'default'` carries the label the caller gives it ("Default · runs",
 * "Inherit · asks"), because "Default" alone does not tell a reader whether
 * the tool runs or asks.
 *
 * `transition-[…,scale]`, not `transition-transform`: Tailwind v4's `scale-*`
 * utility sets the standalone `scale` property, which
 * `transition-property: transform` does not cover — the press would snap.
 */
export function ToolPolicyControl({
  value,
  onChange,
  label,
  disabled = false,
  lockedReason,
  defaultLabel,
}: ToolPolicyControlProps) {
  const policySegments = useLocalizedUiCatalog(POLICY_SEGMENTS);
  const locked = Boolean(lockedReason);

  const group = (
    <div
      role="group"
      aria-label={label}
      className={cn(tabsSegmentedTrackClasses, 'inline-flex h-7 shrink-0 items-stretch gap-0.5')}
    >
      {policySegments.map((segment) => {
        const selected = value === segment.choice;
        return (
          <button
            key={segment.choice}
            type="button"
            aria-pressed={selected}
            disabled={disabled || locked}
            // Re-pressing the current choice is a no-op, not a redundant PUT
            // that rewrites the rule set to what it already is.
            onClick={() => {
              if (!selected) onChange(segment.choice);
            }}
            className={cn(
              'rounded-sm px-2 text-xs font-medium whitespace-nowrap',
              'focus-visible:ring-kortix-blue focus-visible:ring-[0.6px] focus-visible:outline-none',
              'disabled:pointer-events-none disabled:opacity-50',
              'transition-[color,background-color,box-shadow,scale] duration-normal ease-default active:scale-[0.96] motion-reduce:transition-none',
              selected
                ? cn(tabsSegmentedChipClasses, segment.tint)
                : cn('text-muted-foreground', segment.hoverTint),
            )}
          >
            {segment.choice === 'default' && defaultLabel ? defaultLabel : segment.label}
          </button>
        );
      })}
    </div>
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

  return group;
}
