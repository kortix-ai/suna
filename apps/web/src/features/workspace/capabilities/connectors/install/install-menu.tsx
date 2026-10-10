'use client';

import { Button } from '@/components/ui/button';
import { SessionDotMatrix } from '@/components/ui/dot-matrix/session-dot-matrix';
import { cn } from '@/lib/utils';

export interface InstallButtonProps {
  /** The visible label: "Install". */
  label: string;
  onInstall: () => void;
  pending?: boolean;
  disabled?: boolean;
  variant?: 'default' | 'secondary' | 'outline';
  /** Extra classes for the button. */
  className?: string;
  /** Names what is installed when a page has several of these. It must contain `label`. */
  'aria-label'?: string;
  'data-testid'?: string;
}

/**
 * Install adds the app's connector PROFILE to the project, and asks nothing
 * else. Who may use an account is chosen per account, in "Add account" on the
 * connector page Install opens.
 */
export function InstallButton({
  label,
  onInstall,
  pending = false,
  disabled = false,
  variant = 'secondary',
  className,
  'aria-label': ariaLabel,
  'data-testid': testId,
}: InstallButtonProps) {
  return (
    <Button
      type="button"
      size="sm"
      variant={variant}
      className={cn(
        variant !== 'default' &&
          'hover:border-ring hover:ring-ring/15 hit-area-y-3 hit-area-l-3 shrink-0 border border-transparent hover:border hover:ring-2',
        className,
      )}
      disabled={disabled || pending}
      aria-label={ariaLabel}
      data-testid={testId}
      onClick={onInstall}
    >
      {pending ? <SessionDotMatrix size={14} className="shrink-0" /> : null}
      {label}
    </Button>
  );
}
