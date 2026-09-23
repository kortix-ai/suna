/**
 * The thinking-effort picker.
 *
 * Effort is the selected model's **variant** — `Object.keys(model.variants)`,
 * which the catalog derives from models.dev's `reasoning_options`. It is never
 * a hardcoded ladder: a model that publishes `low|medium|high` offers those
 * three, and a model that publishes none offers only Auto.
 *
 * `Auto` is first and always present. It clears the variant so the model's own
 * default applies (on-gateway, the project's Generation defaults fill it), and
 * without it the control would be a one-way door — the same rule apps/web's
 * `reasoning-effort-selector.tsx` states.
 */

import type { ListItem } from '../../../ui/index.ts';
import { InlinePicker } from './inline-picker.tsx';
import { effortLabel } from './use-composer-selection.ts';

export const AUTO_EFFORT_ID = 'effort:auto';

export function effortPickerItems(
  variants: readonly string[],
  selected: string | null,
): ListItem[] {
  const items: ListItem[] = [
    {
      id: AUTO_EFFORT_ID,
      label: `${selected === null ? '● ' : '  '}Auto`,
      right: 'model decides',
    },
  ];
  for (const value of variants) {
    items.push({
      id: `effort:${value}`,
      label: `${selected === value ? '● ' : '  '}${effortLabel(value)}`,
      right: value,
    });
  }
  return items;
}

export interface EffortPickerProps {
  variants: readonly string[];
  selected: string | null;
  onPick: (variant: string | null) => void;
  onClose: () => void;
  width: number;
  maxRows?: number;
}

export function EffortPicker({
  variants,
  selected,
  onPick,
  onClose,
  width,
  maxRows,
}: EffortPickerProps) {
  const items = effortPickerItems(variants, selected);
  return (
    <InlinePicker
      title="Thinking effort"
      items={items}
      initialId={selected ? `effort:${selected}` : AUTO_EFFORT_ID}
      width={width}
      maxRows={maxRows}
      onClose={onClose}
      onPick={(item) => onPick(item.id === AUTO_EFFORT_ID ? null : item.id.slice('effort:'.length))}
    />
  );
}
