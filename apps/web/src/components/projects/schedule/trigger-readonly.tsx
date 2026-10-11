'use client';

/** The sheet's body for a viewer who may not update the trigger: the same facts, as one read-only list. */

import { useTranslations } from '@/i18n/use-translations';
import type { ProjectTrigger } from '@kortix/sdk';

import { type EventAppIndex, describeEventSource } from './event-trigger-copy';
import { describeNextRun, describeRunLocation, describeWhen } from './schedule-copy';
import { PropertyList } from './schedule-fields';

function accessSummary(access: ProjectTrigger['session_access']): string {
  if (access.mode === 'project') return 'Every project member can open trigger-created sessions.';
  if (access.mode === 'members') {
    const count = access.memberIds.length + access.groupIds.length;
    return `${count} selected ${count === 1 ? 'member or group can' : 'members or groups can'} open trigger-created sessions.`;
  }
  return 'The trigger agent and project Managers can open trigger-created sessions.';
}

export function TriggerReadOnly({
  trigger,
  apps,
  eventNames,
  agentLabel,
}: {
  trigger: ProjectTrigger;
  apps: EventAppIndex;
  eventNames: ReadonlyMap<string, string>;
  agentLabel: string;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const conditions = Object.entries(trigger.filter ?? {});
  const when = [describeWhen(trigger, eventNames), describeNextRun(trigger)].filter(Boolean);
  return (
    <section className="bg-popover rounded-md border px-4 py-4">
      <PropertyList
        rows={[
          { label: t.raw('textcf9c7aa24a26'), value: when.join(' · ') },
          ...(trigger.event
            ? [
                {
                  label: t.raw('text5441e7146193'),
                  value: describeEventSource(trigger.event, t, apps),
                },
              ]
            : []),
          {
            label: t.raw('textc74ea9dc9cd2'),
            value: <span className="whitespace-pre-wrap">{trigger.prompt_template}</span>,
          },
          { label: t.raw('text11b39c93777e'), value: agentLabel },
          { label: t.raw('text5e2c614c23f0'), value: trigger.model ?? t.raw('text57069bbd0d2e') },
          { label: t.raw('text345e6cf10469'), value: describeRunLocation(trigger) },
          { label: t.raw('textbc9424d3f527'), value: accessSummary(trigger.session_access) },
          ...(trigger.type === 'cron'
            ? []
            : [
                {
                  label: t.raw('text94c7226773af'),
                  value:
                    conditions.length === 0 ? (
                      t.raw('textbce22443b335')
                    ) : (
                      <span className="space-y-0.5">
                        {conditions.map(([path, value]) => (
                          <code key={path} className="block font-mono text-xs">
                            {path} = {value}
                          </code>
                        ))}
                      </span>
                    ),
                },
              ]),
        ]}
      />
    </section>
  );
}
