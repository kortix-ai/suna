import { MODEL_SELECTOR_PROVIDER_IDS } from '@/features/providers/provider-branding';
import { pickerGroupId, pickerGroupLabel } from '@/features/session/model-grouping';
import type { FlatModel } from '@/features/session/session-chat-input';
import { modelKeyToWire } from '@kortix/sdk/react';

/**
 * Row/group shaping for the "Manage models" tab. Pure so it can be tested
 * without rendering, and deliberately built from the SAME `FlatModel[]` and the
 * SAME grouping helpers the session picker uses — the two views listing
 * different catalogs (models.dev per-provider vs the gateway's served set) is
 * what let them disagree about which models exist at all.
 */

/** Trailing models.dev snapshot date, e.g. `claude-sonnet-4-5-20250929`. */
const DATED_SUFFIX = /-\d{8}$/;

export interface ModelRow {
  model: FlatModel;
  /** The id the server stores enablement against. */
  wireId: string;
  /**
   * True when this is the undated pointer for a family that also publishes
   * pinned snapshots — `claude-sonnet-4-5` alongside
   * `claude-sonnet-4-5-20250929`. Both are separately selectable models with
   * identical display names, so the list has to say which is which.
   */
  isRollingAlias: boolean;
}

export interface ModelGroup {
  providerID: string;
  providerName: string;
  rows: ModelRow[];
}

function releasedAt(model: FlatModel): number {
  const ms = model.releaseDate ? new Date(model.releaseDate).getTime() : Number.NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

function matchesSearch(model: FlatModel, query: string): boolean {
  if (!query) return true;
  return (
    model.modelName.toLowerCase().includes(query) || model.modelID.toLowerCase().includes(query)
  );
}

/**
 * Group by real upstream provider, newest model first, with rolling aliases
 * flagged. Provider order matches the session picker's.
 */
export function buildModelGroups(models: FlatModel[], search = ''): ModelGroup[] {
  const query = search.trim().toLowerCase();
  const groups = new Map<string, ModelGroup>();

  for (const model of models) {
    if (!matchesSearch(model, query)) continue;
    const providerID = pickerGroupId(model);
    const group = groups.get(providerID);
    const row: ModelRow = {
      model,
      wireId: modelKeyToWire({ providerID: model.providerID, modelID: model.modelID }),
      isRollingAlias: false,
    };
    if (group) group.rows.push(row);
    else {
      groups.set(providerID, {
        providerID,
        providerName: pickerGroupLabel(providerID, model),
        rows: [row],
      });
    }
  }

  for (const group of groups.values()) {
    const dated = new Set<string>();
    for (const row of group.rows) {
      if (DATED_SUFFIX.test(row.model.modelID)) {
        dated.add(row.model.modelID.replace(DATED_SUFFIX, ''));
      }
    }
    for (const row of group.rows) {
      row.isRollingAlias = !DATED_SUFFIX.test(row.model.modelID) && dated.has(row.model.modelID);
    }
    group.rows.sort(
      (a, b) =>
        releasedAt(b.model) - releasedAt(a.model) ||
        a.model.modelName.localeCompare(b.model.modelName),
    );
  }

  return [...groups.values()].sort((a, b) => {
    const ai = MODEL_SELECTOR_PROVIDER_IDS.indexOf(a.providerID);
    const bi = MODEL_SELECTOR_PROVIDER_IDS.indexOf(b.providerID);
    if (ai >= 0 && bi < 0) return -1;
    if (ai < 0 && bi >= 0) return 1;
    if (ai >= 0 && bi >= 0) return ai - bi;
    return a.providerName.localeCompare(b.providerName);
  });
}
