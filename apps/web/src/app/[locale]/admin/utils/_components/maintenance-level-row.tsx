'use client';

import { Badge } from '@/components/ui/badge';
import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
import type { MaintenanceLevel } from '@/lib/maintenance-store';
import { cn } from '@/lib/utils';

import { MAINTENANCE_LEVELS, MAINTENANCE_TONE_GLYPH, MAINTENANCE_TONE_TILE } from './constants';

/**
 * One selectable notification level.
 *
 * An entity row (`kortix-design-system` → *Entity row*), not a `Card`. The
 * previous revision was a `Card` with `cursor-pointer`, `transition-all`, a
 * `border-2` on the active one and a `rounded-2xl` icon tile — four separate
 * rejected defaults, and the `border-2` shifted every neighbouring row by 1px
 * whenever the selection moved.
 *
 * Selection is now the system's own persistent-selection fill (`bg-active`)
 * plus a `Badge`, so nothing about the box changes size. It is a real
 * `<button>`, so it is reachable and operable from the keyboard — the `div`
 * with an `onClick` it replaces was neither.
 */
export function MaintenanceLevelRow({
  level,
  isSelected,
  onClick,
}: {
  level: MaintenanceLevel;
  isSelected: boolean;
  onClick: () => void;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const config = MAINTENANCE_LEVELS.find((l) => l.value === level);
  if (!config) return null;
  const Icon = config.icon;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={isSelected}
      className={cn(
        'bg-popover flex w-full cursor-pointer items-center gap-3 rounded-md border px-4 py-3 text-left',
        'duration-fast transition-colors ease-out',
        'focus-visible:ring-ring outline-none focus-visible:ring-2',
        isSelected ? 'bg-active' : 'hover:bg-hover',
      )}
    >
      <span
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-sm',
          MAINTENANCE_TONE_TILE[config.tone],
        )}
      >
        <Icon weight="fill" className={cn('size-5', MAINTENANCE_TONE_GLYPH[config.tone])} />
      </span>
      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex items-center gap-2">
          <span className="text-foreground truncate text-sm font-medium">{config.label}</span>
          {isSelected && (
            <Badge variant="outline" size="sm">
              {tI18nComplete.raw('text92340695899b')}
            </Badge>
          )}
        </span>
        <span className="text-muted-foreground block text-xs leading-relaxed">
          {config.description}
        </span>
      </span>
    </button>
  );
}
