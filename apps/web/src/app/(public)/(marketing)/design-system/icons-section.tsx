'use client';

import {
  ArrowSquareOutIcon,
  CaretRightIcon,
  ChatCircleIcon,
  CheckCircleIcon,
  CopyIcon,
  DotsThreeIcon,
  FolderIcon,
  GearSixIcon,
  LightningIcon,
  MagnifyingGlassIcon,
  PaperPlaneTiltIcon,
  PlusIcon,
  RobotIcon,
  TrashIcon,
  UsersIcon,
  WarningIcon,
  type Icon,
  type IconWeight,
} from '@phosphor-icons/react';
import { useState } from 'react';

import { DEFAULT_ICON_WEIGHT, ICON_WEIGHTS } from '@/lib/icons/icon-config';
import { cn } from '@/lib/utils';

const SAMPLE_ICONS: Icon[] = [
  PlusIcon,
  MagnifyingGlassIcon,
  GearSixIcon,
  TrashIcon,
  CopyIcon,
  CheckCircleIcon,
  WarningIcon,
  CaretRightIcon,
  DotsThreeIcon,
  ArrowSquareOutIcon,
  ChatCircleIcon,
  FolderIcon,
  UsersIcon,
  RobotIcon,
  LightningIcon,
  PaperPlaneTiltIcon,
];

export function IconsSection() {
  const [weight, setWeight] = useState<IconWeight>(DEFAULT_ICON_WEIGHT);

  return (
    <section id="icons">
      <div className="border-border/50 mt-14 border-t pt-8" />
      <h2 className="text-muted-foreground mb-5 text-xs tracking-widest uppercase">Icons</h2>
      <p className="text-muted-foreground mb-6 text-base leading-relaxed">
        @phosphor-icons/react only. The app-wide weight is one line in
        src/lib/icons/icon-config.ts, applied by IconProvider; status/solid icons opt out with an
        explicit weight=&quot;fill&quot;. This preview toggle is page-local.
      </p>
      <div className="space-y-4">
        <div className="flex items-center gap-0.5 rounded-md border p-1 w-fit">
          {ICON_WEIGHTS.map((w) => (
            <button
              key={w}
              type="button"
              aria-pressed={w === weight}
              onClick={() => setWeight(w)}
              className={cn(
                'rounded-sm px-2 py-1 text-xs font-medium capitalize transition-colors',
                w === weight
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {w}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-8 gap-3 rounded-md border p-4">
          {SAMPLE_ICONS.map((SampleIcon, i) => (
            <div key={i} className="flex items-center justify-center py-2">
              <SampleIcon weight={weight} className="size-5" />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
