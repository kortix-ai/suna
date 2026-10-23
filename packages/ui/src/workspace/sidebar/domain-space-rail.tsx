'use client';

import { PlusIcon, SquaresFourIcon } from '@phosphor-icons/react';

import { groupByDomain } from '@kortix/sdk';
import { useProjectConfig } from '@kortix/sdk/react';

import { Hint } from '../../primitives/hint';
import { cn } from '../../lib/utils';
import { useActiveDomain } from '../../internal/stores/active-domain-store';

/**
 * The domain/space switcher: a vertical icon rail on the left edge of the
 * project sidebar (the workspace-switcher pattern). Each icon is a domain
 * space; selecting one sets the active domain, and Customize + the surfaces that
 * opt in scope to it. `All` (the grid glyph) clears the scope.
 *
 * Renders nothing until the project declares a domain, so a project that never
 * uses domains keeps the plain single-column sidebar. Colours stay on the
 * neutral brand ramp (selected = inverted, idle = muted) — distinct per-domain
 * hues are not on the Kortix allowlist.
 */
export function DomainSpaceRail({ projectId }: { projectId: string }) {
  const config = useProjectConfig(projectId);
  const [active, setActive] = useActiveDomain(projectId);

  const agents = config?.agents ?? [];
  const groups = groupByDomain(agents, config?.domains);
  const spaces = groups.filter((group) => !group.isDefault);
  if (spaces.length === 0) return null;

  return (
    <nav
      aria-label="Domain spaces"
      className="border-border/60 flex w-[52px] shrink-0 flex-col items-center gap-1.5 border-r py-2"
    >
      <RailButton
        label="All domains"
        selected={active === null}
        onClick={() => setActive(null)}
      >
        <SquaresFourIcon className="size-[18px]" />
      </RailButton>

      <div className="bg-border/70 my-0.5 h-px w-6" aria-hidden />

      {spaces.map((group) => (
        <RailButton
          key={group.name}
          label={group.label}
          selected={active === group.name}
          onClick={() => setActive(group.name)}
        >
          <span className="text-sm font-semibold">{group.label.slice(0, 1).toUpperCase()}</span>
        </RailButton>
      ))}

      <Hint label="New domain" side="right">
        <button
          type="button"
          aria-label="New domain"
          className="text-muted-foreground hover:text-foreground hover:border-border mt-auto flex size-9 items-center justify-center rounded-lg border border-dashed border-transparent transition-colors"
        >
          <PlusIcon className="size-[18px]" />
        </button>
      </Hint>
    </nav>
  );
}

function RailButton({
  label,
  selected,
  onClick,
  children,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Hint label={label} side="right">
      <button
        type="button"
        aria-label={label}
        aria-pressed={selected}
        onClick={onClick}
        className={cn(
          'flex size-9 items-center justify-center rounded-lg transition-colors',
          selected
            ? 'bg-foreground text-background'
            : 'bg-muted text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
      >
        {children}
      </button>
    </Hint>
  );
}
