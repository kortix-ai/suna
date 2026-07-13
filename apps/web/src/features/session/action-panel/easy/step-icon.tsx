'use client';

/**
 * `StepIcon` — the glyph at the head of a Progress row.
 *
 * A row used to lead with an anonymous status dot, which told you a step had
 * *happened* but never what KIND of thing it was. The icon says the kind at a
 * glance (and matches how the Context card leads its rows), while colour still
 * carries the state: muted when done, red when it failed, and the running step
 * keeps its live pulse — the one case where "is it moving?" matters more than
 * "what is it?".
 */

import { cn } from '@/lib/utils';
import {
  Archive,
  Bot,
  Brain,
  CircleHelp,
  FilePen,
  FolderOpen,
  Globe,
  History,
  ListChecks,
  Plug,
  Search,
  Sparkles,
  Terminal,
  Wand2,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { StepFamily } from '../shared/narration';
import type { Step } from '../shared/group-steps';

const FAMILY_ICON: Record<StepFamily, LucideIcon> = {
  explore: Search,
  edit: FilePen,
  run: Terminal,
  web: Globe,
  create: Sparkles,
  plan: ListChecks,
  delegate: Bot,
  sessions: History,
  memory: Brain,
  apps: Plug,
  automations: Zap,
  projects: FolderOpen,
  skills: Wand2,
  ask: CircleHelp,
  retired: Archive,
  other: Wrench,
};

export function StepIcon({ family, status }: { family: StepFamily; status: Step['status'] }) {
  const Glyph = FAMILY_ICON[family] ?? Wrench;

  // A running step is the one thing the eye must find without reading. Keep the
  // pulse it had as a dot, now wrapped around the glyph itself.
  if (status === 'running') {
    return (
      <span className="relative flex size-4 shrink-0 items-center justify-center">
        <span className="bg-kortix-green/25 absolute inline-flex size-4 animate-ping rounded-full motion-reduce:animate-none" />
        <Glyph className="text-kortix-green relative size-4" />
      </span>
    );
  }

  return (
    <Glyph
      className={cn(
        'size-4 shrink-0',
        status === 'error' ? 'text-kortix-red' : 'text-muted-foreground',
      )}
    />
  );
}
