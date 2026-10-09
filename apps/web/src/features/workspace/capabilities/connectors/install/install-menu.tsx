'use client';

import { CaretDownIcon, LockIcon, UsersThreeIcon } from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import { SessionDotMatrix } from '@/components/ui/dot-matrix/session-dot-matrix';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import type { InstallAudience } from './install';

export interface InstallMenuProps {
  /** The visible label: "Install" or "Add account". */
  label: string;
  /** The caller may create a project-owned account. False = one plain button. */
  canShare: boolean;
  /** "Only you". */
  onlyYou: string;
  /** "Everyone in <project>". */
  everyone: string;
  onInstall: (audience: InstallAudience) => void;
  pending?: boolean;
  disabled?: boolean;
  variant?: 'default' | 'secondary' | 'outline';
  /** Extra classes for the trigger button. */
  className?: string;
  /** Names what is installed when a page has several of these. It must contain `label`. */
  'aria-label'?: string;
  'data-testid'?: string;
}

/**
 * One control for "who is this account for": the caller alone, or everyone in
 * the project. It is the only question Install and Add account ask.
 *
 * Each choice is one line with the same glyph the account row uses for that
 * audience, so the menu and the row it produces read as one thing.
 *
 * A member who may not manage the project's connections cannot create a shared
 * account, so for them it is a plain button that installs a private one.
 */
export function InstallMenu({
  label,
  canShare,
  onlyYou,
  everyone,
  onInstall,
  pending = false,
  disabled = false,
  variant = 'secondary',
  className,
  'aria-label': ariaLabel,
  'data-testid': testId,
}: InstallMenuProps) {
  const inactive = disabled || pending;
  const busy = pending ? <SessionDotMatrix size={14} className="shrink-0" /> : null;

  if (!canShare) {
    return (
      <Button
        type="button"
        size="sm"
        variant={variant}
        className={className}
        disabled={inactive}
        aria-label={ariaLabel}
        data-testid={testId}
        onClick={() => onInstall('private')}
      >
        {busy}
        {label}
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant={variant}
          className={className}
          disabled={inactive}
          aria-label={ariaLabel}
          data-testid={testId}
        >
          {busy}
          {label}
          <CaretDownIcon className="size-3.5 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuItem onSelect={() => onInstall('private')}>
          <LockIcon className="size-4 shrink-0" />
          {onlyYou}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onInstall('project')}>
          <UsersThreeIcon className="size-4 shrink-0" />
          {everyone}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
