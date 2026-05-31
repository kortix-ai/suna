// "use client"

// import * as React from "react"
// import * as SheetPrimitive from "@radix-ui/react-dialog"
// import { XIcon } from "lucide-react"

// import { cn } from "@/lib/utils"

// function Sheet({ ...props }: React.ComponentProps<typeof SheetPrimitive.Root>) {
//   return <SheetPrimitive.Root data-slot="sheet" {...props} />
// }

// function SheetTrigger({
//   ...props
// }: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
//   return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />
// }

// function SheetClose({
//   ...props
// }: React.ComponentProps<typeof SheetPrimitive.Close>) {
//   return <SheetPrimitive.Close data-slot="sheet-close" {...props} />
// }

// function SheetPortal({
//   ...props
// }: React.ComponentProps<typeof SheetPrimitive.Portal>) {
//   return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />
// }

// function SheetOverlay({
//   className,
//   ...props
// }: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
//   return (
//     <SheetPrimitive.Overlay
//       data-slot="sheet-overlay"
//       className={cn(
//         "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50",
//         className
//       )}
//       {...props}
//     />
//   )
// }

// function SheetContent({
//   className,
//   children,
//   side = "right",
//   ...props
// }: React.ComponentProps<typeof SheetPrimitive.Content> & {
//   side?: "top" | "right" | "bottom" | "left"
// }) {
//   return (
//     <SheetPortal>
//       <SheetOverlay />
//       <SheetPrimitive.Content
//         data-slot="sheet-content"
//         className={cn(
//           "bg-background data-[state=open]:animate-in data-[state=closed]:animate-out fixed z-50 flex flex-col gap-4 shadow-lg transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500",
//           side === "right" &&
//             "data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right inset-y-0 right-0 h-full w-3/4 border-l sm:max-w-sm",
//           side === "left" &&
//             "data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left inset-y-0 left-0 h-full w-3/4 border-r sm:max-w-sm",
//           side === "top" &&
//             "data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top inset-x-0 top-0 h-auto border-b",
//           side === "bottom" &&
//             "data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom inset-x-0 bottom-0 h-auto border-t",
//           className
//         )}
//         {...props}
//       >
//         {children}
//         <SheetPrimitive.Close className="ring-offset-background focus:ring-ring data-[state=open]:bg-secondary absolute top-4 right-4 cursor-pointer rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none">
//           <XIcon className="size-4" />
//           <span className="sr-only">Close</span>
//         </SheetPrimitive.Close>
//       </SheetPrimitive.Content>
//     </SheetPortal>
//   )
// }

// function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
//   return (
//     <div
//       data-slot="sheet-header"
//       className={cn("flex flex-col gap-1.5 p-4", className)}
//       {...props}
//     />
//   )
// }

// function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
//   return (
//     <div
//       data-slot="sheet-footer"
//       className={cn("mt-auto flex flex-col gap-2 p-4", className)}
//       {...props}
//     />
//   )
// }

// function SheetTitle({
//   className,
//   ...props
// }: React.ComponentProps<typeof SheetPrimitive.Title>) {
//   return (
//     <SheetPrimitive.Title
//       data-slot="sheet-title"
//       className={cn("text-foreground font-semibold", className)}
//       {...props}
//     />
//   )
// }

// function SheetDescription({
//   className,
//   ...props
// }: React.ComponentProps<typeof SheetPrimitive.Description>) {
//   return (
//     <SheetPrimitive.Description
//       data-slot="sheet-description"
//       className={cn("text-muted-foreground text-sm", className)}
//       {...props}
//     />
//   )
// }

// export {
//   Sheet,
//   SheetTrigger,
//   SheetClose,
//   SheetContent,
//   SheetHeader,
//   SheetFooter,
//   SheetTitle,
//   SheetDescription,
// }

'use client';

import * as SheetPrimitive from '@radix-ui/react-dialog';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { Icon } from '@/features/icon/icon';
import { cn } from '@/lib/utils';

const Sheet = SheetPrimitive.Root;

const SheetTrigger = SheetPrimitive.Trigger;

const SheetClose = SheetPrimitive.Close;

const SheetPortal = SheetPrimitive.Portal;

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Overlay
    className={cn(
      'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/80',
      className,
    )}
    {...props}
    ref={ref}
  />
));
SheetOverlay.displayName = SheetPrimitive.Overlay.displayName;

const sheetVariants = cva(
  'fixed z-50 flex min-h-0 flex-col gap-4 overflow-hidden bg-background p-4 shadow-lg transition ease-in-out data-[state=open]:animate-in data-[state=closed]:animate-out h-[calc(100vh-1.4rem)]',
  {
    variants: {
      side: {
        top: 'inset-x-0 top-0 border-b-[1.5px] border-border/40 data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top',
        bottom:
          'inset-x-0 bottom-0 border-t-[1.5px] border-border/40 data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom',
        left: 'inset-y-0 left-0 h-full w-full md:w-3/4 border-r-[1.5px] border-border/40 data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm',
        right:
          'inset-y-0 right-0 h-full md:h-[calc(100vh-1.4rem)] w-full md:w-3/4 border-[1.5px] md:rounded-lg border-border/40 data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm md:m-[0.7rem]',
      },
    },
    defaultVariants: {
      side: 'right',
    },
  },
);

interface SheetContentProps
  extends
    React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content>,
    VariantProps<typeof sheetVariants> {
  showCloseButton?: boolean;
  overlayClassName?: string;
}

const SheetContent = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Content>,
  SheetContentProps
>(
  (
    {
      side = 'right',
      className,
      children,
      showCloseButton = true,
      overlayClassName,
      ...props
    },
    ref,
  ) => (
    <SheetPortal>
      <SheetOverlay className={overlayClassName} />
      <SheetPrimitive.Content
        ref={ref}
        className={cn(sheetVariants({ side }), className)}
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close className="border-input bg-background/80 text-primary ring-offset-background hover:bg-background/80 hover:text-primary focus:ring-ring data-[state=open]:bg-secondary absolute top-4 right-4 inline-flex size-8 items-center justify-center rounded-md border p-0 text-xs font-medium opacity-70 transition-all hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-none disabled:pointer-events-none">
            <Icon.Close className="size-[1.15rem] stroke-0" />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Content>
    </SheetPortal>
  ),
);
SheetContent.displayName = SheetPrimitive.Content.displayName;

const SheetHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'flex shrink-0 flex-col space-y-2 text-center sm:text-left',
      className,
    )}
    {...props}
  />
);
SheetHeader.displayName = 'SheetHeader';

const SheetFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'flex shrink-0 flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2',
      className,
    )}
    {...props}
  />
);
SheetFooter.displayName = 'SheetFooter';

const SheetBody = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'flex min-h-0 flex-1 flex-col items-start justify-start gap-4 overflow-y-auto py-6 w-full',
      className,
    )}
    {...props}
  />
);
SheetBody.displayName = 'SheetBody';

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Title>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Title
    ref={ref}
    className={cn('text-foreground text-lg font-semibold', className)}
    {...props}
  />
));
SheetTitle.displayName = SheetPrimitive.Title.displayName;

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Description>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Description
    ref={ref}
    className={cn('text-muted-foreground text-sm', className)}
    {...props}
  />
));
SheetDescription.displayName = SheetPrimitive.Description.displayName;

export {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetOverlay,
  SheetPortal,
  SheetTitle,
  SheetTrigger,
};
