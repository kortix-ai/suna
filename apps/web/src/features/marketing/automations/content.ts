import { AGENT_AUTOMATION_TRANSLATION_KEYS } from '@/i18n/agent-automation-translation-keys.generated';
import { localizeUiCatalog } from '@/i18n/localize-ui-catalog';
import type { UiTranslator } from '@/i18n/translator';

/**
 * `/automations` copy.
 *
 * Plain English lives here, not in `apps/web/translations/*.json`, so the copy
 * can iterate before paying the 8-locale parity gate (`pnpm i18n:translations`).
 * Wire i18n keys only once the copy is locked.
 *
 * Voice rules: the `kortix-brand` skill.
 * ACCURACY GATE for this page specifically — every claim below traces to
 * `apps/web/content/docs/connect/triggers.mdx` and
 * `apps/web/content/docs/project/manifest.mdx`:
 *  - There are exactly TWO trigger types, `cron` and `webhook`. No third.
 *  - `session_mode` has FOUR values — fresh | reuse | pinned | keyed — and the
 *    default is `fresh`. Do not ship a three-value list.
 *  - There is NO "post the result to a channel" field on a trigger. Do not
 *    imply a trigger delivers its output anywhere. What a triggered session
 *    does with its work is what its prompt asks for.
 *  - Say "agent computer" / "cloud computer" / "sandbox". NEVER "container".
 *  - Never claim a certification. Never name a licence — "open source" and stop.
 *  - Nothing merges itself. A 3am fire still lands through a change request.
 */

export const schedule = {
  eyebrow: 'The cron surface',
  title: 'A schedule you can read in one column.',
  sub: 'Every trigger in a project is one row: what it is called, when it fires, in whose timezone, as which agent, and which session that fire lands in. Nothing about it is hidden state you have to click into.',
  columns: ['Trigger', 'Cron', 'Timezone', 'Agent'] as const,
  rows: [
    {
      slug: 'daily-digest',
      cron: '0 0 9 * * 1-5',
      tz: 'America/Los_Angeles',
      agent: 'kortix',
      mode: 'fresh',
      reads: 'Weekdays at 09:00',
    },
    {
      slug: 'invoice-sweep',
      cron: '0 30 6 1 * *',
      tz: 'Europe/Berlin',
      agent: 'finance',
      mode: 'reuse',
      reads: 'The 1st of the month at 06:30',
    },
    {
      slug: 'oncall-handoff',
      cron: '0 0 17 * * 5',
      tz: 'UTC',
      agent: 'support',
      mode: 'fresh',
      reads: 'Fridays at 17:00',
    },
    {
      slug: 'roadmap-review',
      cron: '0 0 8 * * 1',
      tz: 'America/New_York',
      agent: 'planner',
      mode: 'pinned',
      reads: 'Mondays at 08:00',
    },
  ],
  facts: [
    {
      id: 'timezone',
      k: 'Timezones are real',
      v: 'A trigger stores an IANA timezone name, not an offset, and defaults to UTC. Set America/Los_Angeles and it stays at 09:00 local across a daylight-saving change. An abbreviation like PST is rejected rather than guessed at.',
    },
    {
      id: 'picker',
      k: 'You do not have to write cron',
      v: 'The Schedules screen is a picker — every few minutes, weekdays, every month, or once at a moment you choose. Raw cron is the escape hatch behind it, not the price of entry.',
    },
    {
      id: 'pause',
      k: 'One switch pauses everything',
      v: 'A project-level pause stops every trigger at once, on top of each trigger’s own enabled flag. Use it when the same repo runs on two control planes so nothing fires twice.',
    },
    {
      id: 'queue',
      k: 'A burst queues, it does not drop',
      v: 'A project runs 3 triggered sessions provisioning at once by default. A fire past that limit comes back queued and runs when a slot frees, rather than failing.',
    },
  ],
} as const;

export function getLocalizedAutomationsContent(tI18nComplete: UiTranslator) {
  return localizeUiCatalog(
    { schedule },
    tI18nComplete,
    AGENT_AUTOMATION_TRANSLATION_KEYS,
  );
}
