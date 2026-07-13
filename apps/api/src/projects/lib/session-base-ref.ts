export type SessionBaseRefGroupDefault = {
  groupId: string;
  groupName: string;
  baseRef: string;
};

export type EffectiveSessionBaseRef = {
  ref: string;
  source: 'explicit' | 'group' | 'project';
  groups: Array<{ groupId: string; groupName: string }>;
  conflict: boolean;
  conflictingRefs: string[];
};

/**
 * Resolve the branch a session forks from.
 *
 * Explicit per-session selection wins. Group defaults apply only when every
 * matching group agrees on one ref. A user in groups with different defaults
 * falls back to the project default instead of receiving an order-dependent
 * branch from Postgres row order.
 */
export function selectEffectiveSessionBaseRef(input: {
  explicitRef?: string | null;
  projectDefaultRef: string;
  groupDefaults: SessionBaseRefGroupDefault[];
}): EffectiveSessionBaseRef {
  const explicitRef = input.explicitRef?.trim();
  if (explicitRef) {
    return {
      ref: explicitRef,
      source: 'explicit',
      groups: [],
      conflict: false,
      conflictingRefs: [],
    };
  }

  const defaults = input.groupDefaults
    .map((entry) => ({ ...entry, baseRef: entry.baseRef.trim() }))
    .filter((entry) => entry.baseRef.length > 0);
  const refs = [...new Set(defaults.map((entry) => entry.baseRef))].sort();

  if (refs.length === 1) {
    const ref = refs[0]!;
    const groups = defaults
      .filter((entry) => entry.baseRef === ref)
      .map(({ groupId, groupName }) => ({ groupId, groupName }))
      .sort((a, b) => a.groupName.localeCompare(b.groupName) || a.groupId.localeCompare(b.groupId));
    return {
      ref,
      source: 'group',
      groups,
      conflict: false,
      conflictingRefs: [],
    };
  }

  return {
    ref: input.projectDefaultRef,
    source: 'project',
    groups: [],
    conflict: refs.length > 1,
    conflictingRefs: refs.length > 1 ? refs : [],
  };
}
