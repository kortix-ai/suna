import * as React from 'react';

import { cn } from '../lib/utils';

/**
 * Message: one conversation row. `align="end"` for the local user, `"start"`
 * for the agent. Compose with `Bubble` for the surface and `MessageAvatar` for
 * the avatar slot.
 */
function Message({
  className,
  align = 'start',
  ...props
}: React.ComponentProps<'div'> & { align?: 'start' | 'end' }) {
  return (
    <div
      data-slot="message"
      data-align={align}
      className={cn(
        'flex w-full items-end gap-2.5',
        align === 'end' ? 'flex-row-reverse' : 'flex-row',
        className,
      )}
      {...props}
    />
  );
}

function MessageGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="message-group" className={cn('flex flex-col gap-1.5', className)} {...props} />;
}

function MessageAvatar({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="message-avatar" className={cn('shrink-0 self-end', className)} {...props} />;
}

function MessageContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="message-content" className={cn('flex min-w-0 flex-col gap-1', className)} {...props} />
  );
}

function MessageHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="message-header"
      className={cn('text-muted-foreground flex items-center gap-2 text-xs', className)}
      {...props}
    />
  );
}

function MessageFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="message-footer"
      className={cn('text-muted-foreground flex items-center gap-2 text-xs', className)}
      {...props}
    />
  );
}

export { Message, MessageAvatar, MessageContent, MessageFooter, MessageGroup, MessageHeader };
