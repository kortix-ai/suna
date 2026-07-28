'use client';

/**
 * One card in the Skills grid — ux-references/perplexity/08-skills-list.png.
 *
 * Name, two lines of description, a ⋮ menu. The whole card opens the detail
 * modal; the menu carries the actions that used to live in the detail toolbar
 * of the old split view, so nothing that was one click away got further away.
 */

import { MoreHorizontal } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { errorToast, successToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

import { type SkillEntity, type SkillKind, skillDisplayName } from './skill-entities';

export interface SkillCardProps {
  kind: SkillKind;
  entity: SkillEntity;
  onOpen: () => void;
  /** Omitted for read-only viewers — the READ leaf without WRITE. */
  onEdit?: () => void;
  /** A configure session is being minted; the menu item waits rather than double-firing. */
  editing?: boolean;
  className?: string;
}

export function SkillCard({ kind, entity, onOpen, onEdit, editing, className }: SkillCardProps) {
  const name = skillDisplayName(kind, entity);

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(entity.path);
      successToast('Path copied');
    } catch {
      errorToast('Copy failed');
    }
  };

  return (
    <div
      className={cn(
        'group border-border bg-popover relative rounded-lg border transition-colors',
        'hover:bg-accent/40',
        className,
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${name}`}
        className={cn(
          'flex w-full flex-col gap-1 rounded-lg px-4 py-3.5 pr-11 text-left',
          'focus-visible:ring-kortix-blue/50 focus-visible:ring-2 focus-visible:outline-none',
        )}
      >
        <span className="text-foreground truncate text-sm font-medium">{name}</span>
        <span className="text-muted-foreground line-clamp-2 text-xs leading-relaxed">
          {entity.description ?? entity.path}
        </span>
      </button>

      <div className="absolute top-2.5 right-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon" aria-label={`Actions for ${name}`}>
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onOpen()}>Open</DropdownMenuItem>
            {onEdit ? (
              <DropdownMenuItem disabled={editing} onSelect={() => onEdit()}>
                Edit
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={() => void copyPath()}>Copy path</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

export default SkillCard;
