import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import { schedule } from './content';

/**
 * The trigger list, drawn as the thing it is: five columns of mono text, one
 * row per trigger. The section's claim is that a schedule is readable at a
 * glance, so the visual has to be a table rather than a picture of one.
 *
 * The cron expressions are the product's real 6-field form (second, minute,
 * hour, day, month, weekday). The plain-English gloss sits beside each row
 * because nobody reads `0 0 9 * * 1-5` as "weekdays at nine" on sight.
 */
export function ScheduleTable(): ReactNode {
  return (
    <div className="border-border bg-card overflow-x-auto rounded-sm border">
      <table className="w-full min-w-max border-collapse text-left">
        <thead>
          <tr className="border-border border-b">
            {schedule.columns.map((column) => (
              <th
                key={column}
                scope="col"
                className="text-muted-foreground px-5 py-4 font-mono text-[10px] font-normal tracking-widest uppercase sm:px-6"
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
                className="text-foreground px-5 py-4 font-mono text-[12.5px] font-normal whitespace-nowrap sm:px-6"
              >
                {row.slug}
              </th>
              <td className="px-5 py-4 sm:px-6">
                <span className="text-foreground block font-mono text-[12.5px] whitespace-nowrap">
                  {row.cron}
                </span>
                <span className="text-muted-foreground/60 mt-1 block text-[11px] whitespace-nowrap">
                  {row.reads}
                </span>
              </td>
              <td className="text-muted-foreground px-5 py-4 font-mono text-[12.5px] whitespace-nowrap sm:px-6">
                {row.tz}
              </td>
              <td className="text-muted-foreground px-5 py-4 font-mono text-[12.5px] whitespace-nowrap sm:px-6">
                {row.agent}
              </td>
              <td className="px-5 py-4 sm:px-6">
                <span className="border-border text-muted-foreground rounded-sm border px-2 py-1 font-mono text-[10px] tracking-widest uppercase">
                  {row.mode}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
