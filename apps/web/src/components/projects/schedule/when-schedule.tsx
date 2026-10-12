'use client';

import { ScheduleBuilder } from '@/components/scheduled-tasks/schedule-builder';

import { InlineError, type PatchDraft } from './composer-parts';
import { TimezoneField } from './schedule-fields';
import type { ComposerDraft } from './trigger-composer-logic';

/** When: a repeating schedule, or one run at a set time. */
export function WhenSchedule({
  draft,
  patch,
  error,
}: {
  draft: ComposerDraft;
  patch: PatchDraft;
  error?: string;
}) {
  return (
    <div className="space-y-3">
      <ScheduleBuilder
        value={draft.cron}
        onChange={(cron) => patch({ cron })}
        allowOnce
        runAt={draft.runAt}
        onRunAtChange={(runAt) => patch({ runAt })}
      />
      {!draft.runAt && (
        <TimezoneField value={draft.timezone} onChange={(timezone) => patch({ timezone })} />
      )}
      <InlineError message={error} />
    </div>
  );
}
