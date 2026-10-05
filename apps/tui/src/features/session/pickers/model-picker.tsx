/**
 * The model picker: every model the project offers, grouped by its real
 * provider, with the unavailable ones marked and still visible.
 *
 * Availability is server-owned (`FlatModel.enabled`, resolved per project by
 * `GET /projects/:id/model-picker`). An unavailable model is DIMMED and tagged
 * `off`, never hidden: a user who cannot find a model they know exists has no
 * way to learn it was turned off. Picking one is refused with a toast rather
 * than silently writing a selection the gateway would reject.
 */

import type { FlatModel, ModelKey } from '@kortix/sdk/react';
import { useMemo } from 'react';

import type { ListItem } from '../../../ui/index.ts';
import { InlinePicker } from './inline-picker.tsx';
import { type ModelGroup, isUnavailable, modelRowId } from './model-groups.ts';

const HEADER_PREFIX = 'group:';

/** Rows for the picker: a heading per provider, then that provider's models. */
export function modelPickerItems(
  groups: readonly ModelGroup[],
  selected: { providerID: string; modelID: string } | null,
): { items: ListItem[]; headerIds: Set<string> } {
  const items: ListItem[] = [];
  const headerIds = new Set<string>();
  for (const group of groups) {
    const headerId = `${HEADER_PREFIX}${group.id}`;
    headerIds.add(headerId);
    items.push({ id: headerId, label: group.label, dim: true });
    for (const model of group.models) {
      const unavailable = isUnavailable(model);
      const current = selected
        ? model.providerID === selected.providerID && model.modelID === selected.modelID
        : false;
      items.push({
        id: modelRowId(model),
        // The group heading already names the provider, so the row carries the
        // model name plus the wire id — what a user actually needs to tell
        // `claude-sonnet-5` from `anthropic/claude-sonnet-5-20260101` apart.
        label: `${current ? '● ' : '  '}${model.modelName}`,
        right: unavailable ? 'off' : model.modelID,
        dim: unavailable,
      });
    }
  }
  return { items, headerIds };
}

export interface ModelPickerProps {
  groups: readonly ModelGroup[];
  models: readonly FlatModel[];
  selected: ModelKey | null;
  onPick: (key: ModelKey) => void;
  onUnavailable: (model: FlatModel) => void;
  onClose: () => void;
  width: number;
  maxRows?: number;
}

export function ModelPicker({
  groups,
  models,
  selected,
  onPick,
  onUnavailable,
  onClose,
  width,
  maxRows,
}: ModelPickerProps) {
  const { items, headerIds } = useMemo(
    () => modelPickerItems(groups, selected),
    [groups, selected],
  );

  return (
    <InlinePicker
      title="Model"
      items={items}
      headerIds={headerIds}
      initialId={selected ? modelRowId(selected) : null}
      width={width}
      maxRows={maxRows}
      onClose={onClose}
      onPick={(item) => {
        const model = models.find((candidate) => modelRowId(candidate) === item.id);
        if (!model) return;
        if (isUnavailable(model)) {
          onUnavailable(model);
          return;
        }
        onPick({
          providerID: model.providerID,
          modelID: model.modelID,
          ...(model.provider ? { provider: model.provider } : {}),
        });
      }}
    />
  );
}
