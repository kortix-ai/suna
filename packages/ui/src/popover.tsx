// Radix Popover (the primitive apps/web uses) on the kit's floating surface: k-popover, k-popover-panel.
import * as P from '@radix-ui/react-popover';

export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverAnchor = P.Anchor;

export function PopoverContent({ className = '', sideOffset = 6, align = 'start', ...props }: P.PopoverContentProps) {
  return (
    <P.Portal>
      <P.Content sideOffset={sideOffset} align={align} collisionPadding={8} className={`k-popover k-popover-panel ${className}`} {...props} />
    </P.Portal>
  );
}
