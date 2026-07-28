'use client';

/**
 * The chrome the three signed-out section demos share.
 *
 * Each demo renders the real ProjectSectionPage with real content, so the only
 * thing they have in common is that every control is inert-but-visible: the
 * pills, the search box and the primary action all look and sit exactly where
 * the signed-in ones do, and all of them route to sign-in instead of doing the
 * thing. Showing the affordance and gating the doing is the whole point — a
 * disabled or missing control would teach a visitor the wrong screen.
 */

import { Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { ProjectSectionSearch } from '@/features/workspace/project-section/project-section-page';

export interface DemoPillOption {
  id: string;
  label: string;
}

/**
 * The filter row. The first pill is the one the demo is showing; the rest are
 * real tabs of the real screen, and gate.
 */
export function DemoPills({
  options,
  active,
  onGate,
}: {
  options: readonly DemoPillOption[];
  active: string;
  onGate: () => void;
}) {
  return (
    <div className="flex items-center gap-1">
      {options.map((option) => (
        <Button
          key={option.id}
          type="button"
          size="sm"
          variant={option.id === active ? 'secondary' : 'ghost'}
          aria-current={option.id === active ? 'page' : undefined}
          onClick={onGate}
          className="rounded-full"
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}

/** The single primary action, top right. */
export function DemoAction({ label, onGate }: { label: string; onGate: () => void }) {
  return (
    <Button type="button" size="sm" onClick={onGate}>
      <Plus className="size-4" />
      {label}
    </Button>
  );
}

/**
 * The search field. Typing is not swallowed silently — the first keystroke
 * gates, because a search box that accepts text and never filters is worse
 * than no search box.
 */
export function demoSearch(placeholder: string, onGate: () => void): ProjectSectionSearch {
  return { value: '', onChange: onGate, placeholder };
}
