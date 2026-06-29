import type { ChangeRequest } from '@/features/project-files/api/change-requests';
import type { ProjectCommit } from '@/lib/projects-client';

export const KORTIX_AGENT_EMAIL = 'agent@kortix.ai';

export function commitTime(c: ProjectCommit): number {
  return Number(new Date(c.committed_at || c.authored_at).getTime()) || Date.now();
}

export function isKortixAgent(c: ProjectCommit): boolean {
  if (c.author_email?.trim().toLowerCase() === KORTIX_AGENT_EMAIL) return true;
  const name = c.author_name?.trim().toLowerCase();
  return name === 'kortix agent' || name === 'cortex agent';
}

export function crTime(cr: ChangeRequest): number {
  const iso =
    cr.status === 'merged'
      ? (cr.merged_at ?? cr.updated_at ?? cr.created_at)
      : cr.status === 'closed'
        ? (cr.closed_at ?? cr.updated_at ?? cr.created_at)
        : cr.created_at;
  return Number(new Date(iso).getTime()) || Date.now();
}

export function dayLabel(ts: number, referenceDate = new Date()): string {
  const now = referenceDate;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = today - 86_400_000;
  const weekStart = today - now.getDay() * 86_400_000;
  const d = new Date(ts);
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (day >= today) return 'Today';
  if (day >= yesterday) return 'Yesterday';
  if (day >= weekStart) return 'This week';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
}

export type TimelineItem =
  | { kind: 'checkpoint'; commit: ProjectCommit; at: number; key: string }
  | { kind: 'cr'; cr: ChangeRequest; at: number; key: string };

export function buildTimeline(commits: ProjectCommit[], crs: ChangeRequest[]): TimelineItem[] {
  return [
    ...commits.map((commit) => ({
      kind: 'checkpoint' as const,
      commit,
      at: commitTime(commit),
      key: `cp:${commit.hash}`,
    })),
    ...crs.map((cr) => ({
      kind: 'cr' as const,
      cr,
      at: crTime(cr),
      key: `cr:${cr.cr_id}`,
    })),
  ];
}

export function groupTimeline(items: TimelineItem[], referenceDate = new Date()) {
  const sorted = [...items].sort((a, b) => b.at - a.at);
  const order: string[] = [];
  const groups = new Map<string, TimelineItem[]>();
  for (const item of sorted) {
    const label = dayLabel(item.at, referenceDate);
    if (!groups.has(label)) {
      groups.set(label, []);
      order.push(label);
    }
    groups.get(label)!.push(item);
  }
  return order.map((label) => ({ label, items: groups.get(label)! }));
}
