import type { ProjectSession, ProjectSessionInitiator } from '../api/types.ts';
import { takeFlagBool, takeFlagValue, takeFlagValues } from '../command-helpers.ts';

export type StartedByFilter = 'me' | 'others' | 'automated';

export interface SessionListFlags {
  startedBy?: StartedByFilter;
  search?: string;
  children?: string;
  /** Sessions carrying every one of these labels. */
  labels?: string[];
  /** Conversations you were asked into (`participant=me`). */
  asked?: boolean;
}

/** Consume the `sessions ls` list flags from argv. Throws a usage message. */
export function takeSessionListFlags(rest: string[]): SessionListFlags {
  const picked: StartedByFilter[] = [];
  if (takeFlagBool(rest, ['--mine'])) picked.push('me');
  if (takeFlagBool(rest, ['--shared'])) picked.push('others');
  if (takeFlagBool(rest, ['--automated'])) picked.push('automated');
  if (picked.length > 1) throw new Error('pass only one of --mine, --shared, --automated');
  const search = takeFlagValue(rest, ['--search'])?.trim();
  if (search !== undefined && (search.length < 1 || search.length > 200)) {
    throw new Error('--search takes 1 to 200 characters');
  }
  const children = takeFlagValue(rest, ['--children']);
  if (children && picked.length) throw new Error('--children cannot be combined with --mine, --shared or --automated');
  const labels = takeFlagValues(rest, ['--label']);
  const asked = takeFlagBool(rest, ['--asked']);
  return { startedBy: picked[0], search, children, ...(labels.length ? { labels } : {}), ...(asked ? { asked } : {}) };
}

/**
 * Query string for `GET /projects/:id/sessions`. No flag = the flat list of
 * every session, parents and children (the unchanged default: a coordinator
 * agent lists its workers with it). A starter filter lists top-level sessions;
 * `--children` lists one session's children.
 */
export function sessionListQuery(flags: SessionListFlags, parentId?: string): string {
  const params = new URLSearchParams();
  if (parentId) params.set('parent', parentId);
  else if (flags.startedBy) params.set('parent', 'root');
  if (flags.startedBy) params.set('started_by', flags.startedBy);
  if (flags.search) params.set('q', flags.search);
  for (const label of flags.labels ?? []) params.append('label', label);
  if (flags.asked) params.set('participant', 'me');
  return params.size > 0 ? `?${params}` : '';
}

/** STARTED BY cell: "you" for the viewer, else the initiator label. */
export function startedByLabel(s: ProjectSession, viewerId: string | undefined): string {
  const i: ProjectSessionInitiator | null | undefined = s.initiator;
  if (!i) return '-';
  if (i.type === 'member' && viewerId && i.id === viewerId) return 'you';
  return i.label ?? i.id ?? '-';
}
