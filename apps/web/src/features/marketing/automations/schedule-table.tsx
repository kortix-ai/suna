import { cn } from '@/lib/utils';
import { useTranslations } from '@/i18n/use-translations';
import type { ReactNode } from 'react';
import { getLocalizedAutomationsContent } from './content';

/**
 * The trigger list, drawn as the thing it is: four columns of mono text, one
 * row per trigger. The section's claim is that a schedule is readable at a
 * glance, so the visual has to be a table rather than a picture of one.
 *
 * The cron expressions are the product's real 6-field form (second, minute,
 * hour, day, month, weekday). The plain-English gloss sits beside each row
 * because nobody reads `0 0 9 * * 1-5` as "weekdays at nine" on sight.
 */
/** The timezone column shows from xl up: in the half-width column below that,
 *  four columns do not fit and the table would scroll inside its card. */
const TZ_COLUMN = 2;

export function ScheduleTable(): ReactNode {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { schedule } = getLocalizedAutomationsContent(tI18nComplete);
  return (
    <div className="border-border bg-card overflow-x-auto rounded-sm border">
      <table className="w-full min-w-max border-collapse text-left">
        <thead>
          <tr className="border-border border-b">
            {schedule.columns.map((column, i) => (
              <th
                key={column}
                scope="col"
                className={cn(
                  'text-muted-foreground px-4 py-4 font-mono text-[10px] font-normal tracking-widest uppercase',
                  i === TZ_COLUMN && 'hidden xl:table-cell',
                )}
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {schedule.rows.map((row, i) => (
            <tr key={row.slug} className={cn('border-border', i > 0 && 'border-t')}>
              <th
                scope="row"
                className="text-foreground px-4 py-4 font-mono text-[12.5px] font-normal whitespace-nowrap"
              >
                {row.slug}
              </th>
              <td className="px-4 py-4">
                <span className="text-foreground block font-mono text-[12.5px] whitespace-nowrap">
                  {row.cron}
                </span>
                <span className="text-muted-foreground/60 mt-1 block text-[11px] whitespace-nowrap">
                  {row.reads}
                </span>
              </td>
              <td className="text-muted-foreground hidden px-4 py-4 font-mono text-[12.5px] whitespace-nowrap xl:table-cell">
                {row.tz}
              </td>
              <td className="text-muted-foreground px-4 py-4 font-mono text-[12.5px] whitespace-nowrap">
                {row.agent}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
