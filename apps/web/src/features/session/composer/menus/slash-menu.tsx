'use client';

import { cn } from '@/lib/utils';

import type { SlashRow, SlashSection } from './slash-items';

/**
 * Purely presentational, same as `MentionMenu`. Unlike the `@` menu there is
 * no async data source here (commands + actions are both already resolved by
 * the time `createSlashSuggestion` — `slash-controller.ts` — builds a row
 * list), so there is no "Host" wrapper component: the controller computes
 * `sections` directly and hands them down as a prop.
 */
export function SlashMenu({
  sections,
  selectedIndex,
  onSelect,
}: {
  sections: SlashSection[];
  selectedIndex: number;
  onSelect: (row: SlashRow) => void;
}) {
  if (!sections.length) return null;

  return (
    <div
      role="listbox"
      aria-label="Commands and actions"
      aria-activedescendant={`slash-row-${selectedIndex}`}
      className="bg-popover border-border w-[min(28rem,90vw)] overflow-hidden rounded-xl border shadow-md"
    >
      <div className="max-h-80 overflow-y-auto p-1">
        {sections.map((section) => (
          <div key={section.heading}>
            <div className="text-muted-foreground px-2 py-1.5 text-xs font-medium">
              {section.heading}
            </div>
            {section.rows.map((row) => (
              <button
                key={`${row.type}-${row.name}-${row.index}`}
                id={`slash-row-${row.index}`}
                role="option"
                aria-selected={row.index === selectedIndex}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect(row);
                }}
                className={cn(
                  'flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left',
                  row.index === selectedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {row.type === 'command' ? `/${row.name}` : row.name}
                  </div>
                  <p className="text-muted-foreground truncate text-xs">{row.description}</p>
                </div>
                {row.hint && (
                  <kbd className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-sans text-xs">
                    {row.hint}
                  </kbd>
                )}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
