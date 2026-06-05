'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { Icon } from '@/features/icon/icon';
import { cn } from '@/lib/utils';
import { Suspense, useEffect, useState } from 'react';
import { Button } from './button';
import Hint from './hint';
import Loading from './loading';

const Modal = ({ onOpenChange, ...props }: DialogPrimitive.DialogProps) => {
  return <DialogPrimitive.Root onOpenChange={onOpenChange} {...props} />;
};

const ModalTrigger = DialogPrimitive.Trigger;

const ModalClose = DialogPrimitive.Close;

const ModalPortal = DialogPrimitive.Portal;

const ModalOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    className={cn(
      'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-[999] bg-black/60',
      className,
    )}
    {...props}
    ref={ref}
  />
));
ModalOverlay.displayName = DialogPrimitive.Overlay.displayName;

const ModalVariants = cva(
  cn(
    'fixed z-[999] gap-0 border p-0 shadow-lg transition ease-in-out data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:duration-300 data-[state=open]:duration-500 overflow-y-auto',
    'lg:top-[50%] lg:left-[50%] lg:grid lg:w-full lg:max-w-lg lg:-translate-x-1/2 lg:-translate-y-1/2 lg:duration-200 lg:data-[state=open]:animate-in lg:data-[state=closed]:animate-out lg:data-[state=closed]:fade-out-0 lg:data-[state=open]:fade-in-0 lg:data-[state=closed]:zoom-out-95 lg:data-[state=open]:zoom-in-95 lg:rounded-xl',
    'lg:flex lg:h-full lg:flex-col space-y-4',
  ),
  {
    variants: {
      variant: {
        default: 'bg-sidebar border-muted/60',
        base: 'bg-background border-muted/60',
        transparent: 'bg-transparent border-none p-0',
      },
      side: {
        top: 'inset-x-0 top-0 border-b rounded-b-xl max-h-[90%] lg:h-fit max-lg:data-[state=closed]:slide-out-to-top max-lg:data-[state=open]:slide-in-from-top',
        bottom:
          'inset-x-0 bottom-0 lg:bottom-auto border-t lg:h-auto max-h-[90%] rounded-t-xl max-lg:data-[state=closed]:slide-out-to-bottom max-lg:data-[state=open]:slide-in-from-bottom',
        left: 'inset-y-0 left-0 h-full lg:h-fit w-3/4 border-r rounded-r-xl max-lg:data-[state=closed]:slide-out-to-left max-lg:data-[state=open]:slide-in-from-left sm:max-w-sm',
        right:
          'inset-y-0 right-0 h-full lg:h-fit w-3/4 border-l rounded-l-xl max-lg:data-[state=closed]:slide-out-to-right max-lg:data-[state=open]:slide-in-from-right sm:max-w-sm',
        fullscreen:
          'inset-0 z-[999] bg-black/60 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 dark:bg-black/85',
      },
    },
    defaultVariants: {
      side: 'bottom',
      variant: 'default',
    },
  },
);

interface ModalContentProps
  extends
    React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>,
    VariantProps<typeof ModalVariants> {
  closeClassName?: string;
  modalClassName?: string;
  showCloseButton?: boolean;
  closeButtonChildren?: React.ReactNode;
  closeOnOutsideClick?: boolean;
  overlayClassName?: string;
}

const ModalContentInner = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  ModalContentProps
>(
  (
    {
      side = 'bottom',
      className,
      modalClassName,
      closeClassName,
      children,
      variant = 'default',
      showCloseButton = true,
      closeButtonChildren,
      closeOnOutsideClick = true,
      overlayClassName,
      ...props
    },
    ref,
  ) => (
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        ModalVariants({ side, className: modalClassName, variant }),
        className,
        'rounded-xl rounded-b-none lg:rounded-b-xl',
      )}
      onPointerDownOutside={closeOnOutsideClick ? undefined : (e) => e.preventDefault()}
      {...props}
    >
      {children}

      <div className="absolute top-3 right-2 flex items-center justify-end gap-2">
        {closeButtonChildren}
        {showCloseButton && (
          <ModalClose>
            <Hint label="Close" className="z-[9999]" side="top">
              <Button
                variant="ghost"
                className={cn(
                  'size-8 rounded-md p-0 text-xs font-semibold focus:outline-none',
                  closeClassName,
                )}
              >
                <Icon.Close className="text-primary size-4 stroke-1" />
                <span className="sr-only">Close</span>
              </Button>
            </Hint>
          </ModalClose>
        )}
      </div>
    </DialogPrimitive.Content>
  ),
);
ModalContentInner.displayName = 'ModalContentInner';

const ModalContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  ModalContentProps
>((props, ref) => (
  <ModalPortal>
    <ModalOverlay className={props.overlayClassName} />
    <ModalContentInner {...props} ref={ref} />
  </ModalPortal>
));
ModalContent.displayName = DialogPrimitive.Content.displayName;

const ModalHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col space-y-0 text-left', 'px-4 pt-4', className)} {...props} />
);
ModalHeader.displayName = 'ModalHeader';

const ModalFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'flex flex-col-reverse items-center justify-end gap-y-2 rounded-b-none px-4 sm:flex-row sm:justify-end sm:space-x-2 sm:gap-y-0 md:rounded-b-xl md:px-4 lg:rounded-b-xl',

      className,
    )}
    {...props}
  />
);
ModalFooter.displayName = 'ModalFooter';

const ModalTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-foreground text-base font-semibold', className)}
    {...props}
  />
));
ModalTitle.displayName = DialogPrimitive.Title.displayName;

const ModalDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-muted-foreground text-sm', className)}
    {...props}
  />
));
ModalDescription.displayName = DialogPrimitive.Description.displayName;

const ModalLoadingContent = () => {
  return (
    <ModalContentInner className="flex min-h-[300px] items-center justify-center" autoFocus={false}>
      <div className="flex flex-col items-center gap-4">
        <Loading className="h-12 w-12" />
        <p className="text-muted-foreground">Loading content...</p>
      </div>
    </ModalContentInner>
  );
};

// TODO: implement passing props directly to ModalContent
// NOTE: consider moving portal+overlay inside Suspense
const LazyModal = ({
  children,
  open,
  forceMount,
  ...props
}: DialogPrimitive.DialogProps & { forceMount?: boolean }) => {
  const [hasOpened, setHasOpened] = useState(false);

  useEffect(() => {
    if (open) {
      setHasOpened(true);
    }
  }, [open]);

  if (!hasOpened && !forceMount) return null;

  return (
    <Modal open={open} {...props}>
      <ModalPortal>
        <ModalOverlay />
        <Suspense fallback={<ModalLoadingContent />}>{children}</Suspense>
      </ModalPortal>
    </Modal>
  );
};

const ModalBody = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex-1 space-y-4 p-4 pt-0', className)} {...props} />
);
ModalBody.displayName = 'ModalBody';

export {
  LazyModal,
  Modal,
  ModalBody,
  ModalClose,
  ModalContent,
  ModalContentInner,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  ModalPortal,
  ModalTitle,
  ModalTrigger,
};
