import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { Item, ItemActions, ItemContent, ItemMedia, ItemTitle } from '@/components/ui/item';
import { cn } from '@/lib/utils';

const alertVariants = cva('w-full rounded-lg', {
  variants: {
    variant: {
      default: 'bg-card text-card-foreground',
      destructive:
        'text-destructive bg-card [&_[data-slot=item-media]_svg]:text-current [&_[data-slot=item-description]]:text-destructive/90',
      warning:
        'text-kortix-orange   bg-kortix-orange/10 [&_[data-slot=item-media]_svg]:text-current [&_[data-slot=item-description]]:text-kortix-orange/90',
    },
  },
  defaultVariants: {
    variant: 'default',
  },
});

function AlertMedia({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof ItemMedia>) {
  return (
    <ItemMedia
      data-slot="alert-media"
      variant={variant}
      className={cn(
        'size-4 shrink-0 self-start [&_svg]:text-current [&_svg:not([class*="size-"])]:size-4',
        className,
      )}
      {...props}
    />
  );
}

function AlertContent({ className, ...props }: React.ComponentProps<typeof ItemContent>) {
  return <ItemContent data-slot="alert-content" className={className} {...props} />;
}

function AlertTitle({ className, ...props }: React.ComponentProps<typeof ItemTitle>) {
  return (
    <ItemTitle
      data-slot="alert-title"
      className={cn('line-clamp-1 min-h-4 tracking-tight', className)}
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="item-description"
      className={cn(
        'text-muted-foreground text-sm leading-normal font-normal text-balance',
        '[&>a:hover]:text-primary [&>a]:underline [&>a]:underline-offset-4',
        '[&_p]:leading-relaxed',
        className,
      )}
      {...props}
    />
  );
}

function AlertActions({ className, ...props }: React.ComponentProps<typeof ItemActions>) {
  return <ItemActions data-slot="alert-actions" className={className} {...props} />;
}

function partitionAlertChildren(children: React.ReactNode) {
  const mediaChildren: React.ReactNode[] = [];
  const contentChildren: React.ReactNode[] = [];
  const actionChildren: React.ReactNode[] = [];

  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) {
      if (child != null) {
        contentChildren.push(child);
      }
      return;
    }

    if (child.type === AlertMedia) {
      mediaChildren.push(child);
      return;
    }

    if (child.type === AlertActions) {
      actionChildren.push(child);
      return;
    }

    if (
      child.type === AlertTitle ||
      child.type === AlertDescription ||
      child.type === AlertContent
    ) {
      contentChildren.push(child);
      return;
    }

    mediaChildren.push(<AlertMedia key={mediaChildren.length}>{child}</AlertMedia>);
  });

  const hasContentWrapper = contentChildren.some(
    (child) => React.isValidElement(child) && child.type === AlertContent,
  );

  return { mediaChildren, contentChildren, actionChildren, hasContentWrapper };
}

function Alert({
  className,
  variant,
  children,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  const { mediaChildren, contentChildren, actionChildren, hasContentWrapper } =
    partitionAlertChildren(children);

  return (
    <Item
      role="alert"
      data-slot="alert"
      variant="outline"
      size="sm"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    >
      {mediaChildren}
      {contentChildren.length > 0 &&
        (hasContentWrapper ? (
          contentChildren
        ) : (
          <ItemContent data-slot="alert-content">{contentChildren}</ItemContent>
        ))}
      {actionChildren}
    </Item>
  );
}

export { Alert, AlertActions, AlertContent, AlertDescription, AlertMedia, AlertTitle };
