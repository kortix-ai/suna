import { cn } from '@/lib/utils';
import * as React from 'react';

/**
 * The one field surface every text input on the web shares — `Input`,
 * `InputGroup`, `Textarea`, and the search field all read these, so a field
 * looks the same on a white page, a gray card, or inside a modal.
 *
 * `bg-popover` is the top surface in both themes (white / #141414), so the well
 * lifts off any substrate instead of sinking into a `bg-card` panel the way the
 * old `bg-input` fill did. Focus is the `ring` token twice: a solid 1px border
 * plus a 3px 15% halo.
 */
const inputSurfaceClasses = 'bg-popover border-border rounded-md border';
const inputFocusClasses = 'focus:border-ring focus:ring-ring/15 focus:ring-3 focus:outline-none';
const inputInvalidClasses =
  'aria-invalid:border-destructive aria-invalid:ring-destructive/15 aria-invalid:ring-3 aria-invalid:motion-safe:animate-shake';
/** Border and halo change on every focus move, so they swap fast and never move layout. */
const inputTransitionClasses =
  'transition-[border-color,box-shadow] duration-(--duration-fast) ease-out motion-reduce:transition-none';

export type InputProps = Omit<React.ComponentProps<'input'>, 'size'> & {
  /**
   * @deprecated Every input renders the same surface. Kept so existing
   * callers compile; the value is ignored.
   */
  variant?: 'default' | 'secondary' | 'transparent' | 'popover';
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
};

function Input({ className, type, variant: _variant, size = 'sm', ...props }: InputProps) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        inputSurfaceClasses,
        inputFocusClasses,
        inputInvalidClasses,
        inputTransitionClasses,
        'text-foreground file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground flex h-10 w-full min-w-0 px-3 py-1 text-sm font-medium file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
        type === 'search' &&
          '[&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none [&::-webkit-search-results-button]:appearance-none [&::-webkit-search-results-decoration]:appearance-none',
        type === 'file' &&
          'text-muted-foreground file:border-border file:text-foreground p-0 pr-3 italic file:me-3 file:h-full file:border-0 file:border-r file:border-solid file:bg-transparent file:px-3 file:text-sm file:font-medium file:not-italic',
        size === 'xs' && 'h-8 text-xs',
        size === 'sm' && 'h-9 text-sm',
        size === 'md' && 'h-10 text-sm',
        size === 'lg' && 'h-11 text-sm',
        size === 'xl' && 'h-12 text-base',
        className,
      )}
      {...props}
    />
  );
}

export {
  Input,
  inputFocusClasses,
  inputInvalidClasses,
  inputSurfaceClasses,
  inputTransitionClasses,
};
