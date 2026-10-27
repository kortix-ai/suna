'use client';

import { ScheduleBuilder } from './schedule-builder';

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
        // A one-off runs at a local date and time, so it has no timezone field.
        trailing={
          <TimezoneField
            inline
            className="min-w-40 flex-1"
            value={draft.timezone}
            onChange={(timezone) => patch({ timezone })}
          />
        }
      />
      <InlineError message={error} />
    </div>
  );
}
