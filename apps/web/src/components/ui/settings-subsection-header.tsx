import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

/**
 * The heading for a section *inside* a settings pane — one level below the
 * pane's own title.
 *
 * **Why this exists.** `SettingsSectionHeader` is the pane-level block: `h2` at
 * `text-base lg:text-xl`, a `text-sm` description, an action on the right. Once
 * `SettingsTabHeader` started using it for the page title, every section inside
 * a pane was rendering at the *same* size as the pane's own title — so
 * Preferences read as six equal announcements with nothing to say which was the
 * page and which were its parts. There was no hierarchy left to read.
 *
 * This is that missing level:
 *
 * ```
 * SettingsTabHeader        page title   h2  text-base lg:text-xl
 *   SettingsSubsectionHeader  section   h3  text-sm font-medium   ← this file
 *     SettingsRow                 field      text-sm font-normal
 * ```
 *
 * Deliberately quieter than its parent — a section heading must not compete
 * with the pane title, so it drops a size, drops the `lg:` step entirely, and
 * takes `font-medium` rather than a larger scale to carry its weight. It is the
 * shape Linear uses between grouped rows: a small heading, an optional line of
 * explanation, nothing else.
 *
 * It keeps the `action` slot because real sections need one — "Wallpaper" has a
 * reset, "Sounds" has a preview. That is the only reason this is a component
 * rather than a bare `<h3>`, and it is why it replaced the private
 * `SettingsSectionLabel` that grew inside `settings-row.tsx` first: that one had
 * no action slot, so any section needing a control could not use it and quietly
 * reached for the pane-level header instead.
 */
export function SettingsSubsectionHeader({
  title,
  description,
  action,
  className,
}: {
  /**
   * `ReactNode`, not `string`, so a heading can carry a quiet count beside its
   * name — "Groups 3" — the way Linear's settings do.
   *
   * It was `string`, and that cost something real: converting the Access cards
   * to this component meant dropping their `(3)` counts, because there was no
   * way to pass the muted span without widening this. Purely additive — every
   * existing `string` caller still typechecks.
   */
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4',
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        {/* `h3`, not `h2`: the pane title above it is the `h2`, so a section
            heading nests under it. Screen-reader users navigate settings by
            heading level — flattening these to `h2` would present a pane's six
            sections as six sibling pages. */}
        <h3 className="text-foreground text-sm font-medium text-balance">{title}</h3>
        {description ? (
          <p className="text-muted-foreground max-w-[410px] text-xs leading-relaxed text-pretty">
            {description}
          </p>
        ) : null}
      </div>
      {action ? (
        <div className="flex shrink-0 items-center gap-2 sm:justify-end">{action}</div>
      ) : null}
    </div>
  );
}
