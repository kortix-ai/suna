import type { AgentKnowledgeSource, AgentProfile, AgentProfileSections } from '@kortix/sdk';
import { Cron } from 'croner';

export function activeProfileSections(profile: AgentProfile): AgentProfileSections {
  return profile.draft?.sections ?? profile.sections;
}

export function profileDraftCount(profile: AgentProfile): number {
  return profile.draft?.changed_sections.length ?? 0;
}

export function indexedKnowledgeSourceCount(
  sources: Array<Pick<AgentKnowledgeSource, 'status'>>,
): number {
  return sources.filter((source) => source.status === 'ready' || source.status === 'degraded')
    .length;
}

export function slugifyCapabilityName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, '-')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);
}

export function nextScheduleRuns(
  schedule: string,
  timezone: string,
  count = 5,
  after = new Date(),
): string[] {
  const runAt = Date.parse(schedule);
  if (schedule.includes('T') && !Number.isNaN(runAt)) {
    return runAt > after.getTime() ? [new Date(runAt).toISOString()] : [];
  }
  const cron = new Cron(schedule, { paused: true, timezone });
  const runs: string[] = [];
  let cursor = after;
  for (let index = 0; index < count; index += 1) {
    const next = cron.nextRun(cursor);
    if (!next) break;
    runs.push(next.toISOString());
    cursor = next;
  }
  return runs;
}
