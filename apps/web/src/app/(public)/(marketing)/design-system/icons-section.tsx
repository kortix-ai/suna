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

/**
 * Body of the Icons section. The heading, the `#icons` anchor, and the seam are
 * owned by the `CollapsibleSection` wrapper on the design-system page, so this
 * renders content only.
 */
export function IconsSection() {
  const [weight, setWeight] = useState<IconWeight>(DEFAULT_ICON_WEIGHT);

  return (
    <div>
      <p className="text-muted-foreground mb-6 text-base leading-relaxed">
        @phosphor-icons/react only. The app-wide weight is one line in src/lib/icons/icon-config.ts,
        applied by IconProvider; status/solid icons opt out with an explicit
        weight=&quot;fill&quot;. This preview toggle is page-local.
      </p>
      <div className="space-y-4">
        <div className="flex w-fit items-center gap-0.5 rounded-md border p-1">
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
          {SAMPLE_ICONS.map((SampleIcon) => (
            // Phosphor sets a unique displayName on every icon component.
            <div key={SampleIcon.displayName} className="flex items-center justify-center py-2">
              <SampleIcon weight={weight} className="size-5" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
