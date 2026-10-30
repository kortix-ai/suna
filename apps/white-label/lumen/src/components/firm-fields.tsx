'use client';

import { cn } from '@kortix/ui';
import { Button } from '@kortix/ui/button';
import { Label } from '@kortix/ui/label';
import { CheckIcon } from '@phosphor-icons/react';

export const SIZE_BANDS = [
  { value: '1', label: 'Just me' },
  { value: '2-10', label: '2–10 people' },
  { value: '11-50', label: '11–50 people' },
  { value: '51+', label: '51+ people' },
] as const;

export const PRACTICE_TAGS = [
  'M&A', 'Commercial', 'Corporate', 'Real estate', 'Employment', 'Litigation', 'Data protection', 'Finance', 'IP', 'In-house',
];

/** Practice focus: a multi-select of tags. Lumen uses it only to suggest prompts. */
export function TagsInput({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="space-y-1.5">
      <Label id="practice-label">Practice focus</Label>
      <div role="group" aria-labelledby="practice-label" className="flex flex-wrap gap-1.5">
        {PRACTICE_TAGS.map((t) => {
          const on = value.includes(t);
          return (
            <Button
              variant="ghost"
              key={t}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(on ? value.filter((x) => x !== t) : [...value, t])}
              className={cn(
                'flex h-auto items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-normal transition-colors disabled:opacity-50',
                on ? 'border-brand/50 bg-brand/10 text-foreground' : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {on && <CheckIcon className="size-3 text-brand" />}
              {t}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
