import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as React from 'react';

import { Icon } from '@/features/icon/icon';
import { cn } from '@/lib/utils';
import { dialogContentZ, DialogDepthProvider, dialogOverlayZ, useDialogDepth } from '@/lib/z-stack';
import { cva, VariantProps } from 'class-variance-authority';
import { buttonVariants } from './button';

const Dialog = ({ onOpenChange, ...props }: DialogPrimitive.DialogProps) => {
  const parentDepth = useDialogDepth();
  const depth = parentDepth + 1;

  return (
    <DialogDepthProvider depth={depth}>
      <DialogPrimitive.Root onOpenChange={onOpenChange} {...props} />
    </DialogDepthProvider>
  );
};

const DialogTrigger = DialogPrimitive.Trigger;

const DialogPortal = DialogPrimitive.Portal;

const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, style, ...props }, ref) => {
  const depth = useDialogDepth();

  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={cn(
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 bg-black/65 backdrop-blur-xs duration-200',
        className,
      )}
      style={{ zIndex: dialogOverlayZ(depth), ...style }}
      {...props}
    />
  );
});
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogVariants = cva(
  cn(
    'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 border p-5 shadow-lg duration-200 sm:max-w-lg sm:rounded-xl',
  ),
  {
    variants: {
      variant: {
        default: 'bg-sidebar border-muted/60',
        transparent: 'bg-transparent border-none p-0',
      },
    },
    defaultVariants: {
      variant: 'transparent',
    },
  },
);

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> &
    VariantProps<typeof DialogVariants> & {
      hideCloseButton?: boolean;
    }
>(({ className, children, hideCloseButton = false, style, ...props }, ref) => {
  const depth = useDialogDepth();

  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(DialogVariants({ variant: 'default' }), className)}
        style={{ zIndex: dialogContentZ(depth), ...style }}
        {...props}
      >
        {children}
        {!hideCloseButton && (
          <DialogPrimitive.Close
            className={cn(
              buttonVariants({ variant: 'ghost', size: 'icon' }),
              'absolute top-3 right-3',
            )}
          >
            <Icon.Close className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
});
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col space-y-1.5 text-center sm:text-left', className)} {...props} />
);
DialogHeader.displayName = 'DialogHeader';

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2', className)}
    {...props}
  />
);
DialogFooter.displayName = 'DialogFooter';

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-lg leading-none font-semibold tracking-tight', className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-muted-foreground text-sm', className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
