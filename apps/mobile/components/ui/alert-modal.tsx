import { buttonTextVariants, buttonVariants } from "@/components/ui/button";
import { NativeOnlyAnimatedView } from "@/components/ui/native-only-animated-view";
import { TextClassContext } from "@/components/ui/text";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import * as AlertDialogPrimitive from "@rn-primitives/alert-dialog";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { Platform, View, type ViewProps } from "react-native";
import {
  FadeIn,
  FadeInDown,
  FadeInLeft,
  FadeInRight,
  FadeInUp,
  FadeOut,
  FadeOutDown,
  FadeOutLeft,
  FadeOutRight,
  FadeOutUp,
} from "react-native-reanimated";
import { FullWindowOverlay as RNFullWindowOverlay } from "react-native-screens";

const AlertModal = ({
  onOpenChange,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Root>) => {
  return <AlertDialogPrimitive.Root onOpenChange={onOpenChange} {...props} />;
};

const AlertModalTrigger = AlertDialogPrimitive.Trigger;

const AlertModalPortal = AlertDialogPrimitive.Portal;

const FullWindowOverlay = Platform.OS === "ios" ? RNFullWindowOverlay : React.Fragment;

const AlertModalOverlay = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Overlay>,
  React.ComponentProps<typeof AlertDialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <FullWindowOverlay>
    <AlertDialogPrimitive.Overlay
      ref={ref}
      className={cn(
        "absolute inset-0 z-50",
        Platform.select({
          web: "fixed cursor-default bg-black/60 data-[state=closed]:duration-200 data-[state=open]:duration-300 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 dark:bg-black/85 [&>*]:cursor-auto",
          native: "bg-transparent",
        }),
        className,
      )}
      {...props}
    >
      {Platform.OS !== "web" ? (
        <NativeOnlyAnimatedView
          entering={FadeIn.duration(280)}
          exiting={FadeOut.duration(200)}
          className="absolute inset-0 bg-black/60 dark:bg-black/85"
          pointerEvents="none"
        />
      ) : null}
    </AlertDialogPrimitive.Overlay>
  </FullWindowOverlay>
));
AlertModalOverlay.displayName = "AlertModalOverlay";

const AlertModalContentWeb = AlertDialogPrimitive.Content as React.ComponentType<
  React.ComponentProps<typeof AlertDialogPrimitive.Content> & {
    dataSet?: { state: "open" | "closed" };
  }
>;

const webSheetEase = "max-lg:ease-[cubic-bezier(0.32,0.72,0,1)]";

const webEnterBottom = cn(
  "max-lg:animate-in max-lg:fade-in-0 max-lg:slide-in-from-bottom max-lg:duration-[420ms]",
  webSheetEase,
);
const webExitBottom = cn(
  "max-lg:data-[state=closed]:animate-out max-lg:data-[state=closed]:fade-out-0 max-lg:data-[state=closed]:slide-out-to-bottom max-lg:data-[state=closed]:duration-[280ms]",
);
const webEnterTop = cn(
  "max-lg:animate-in max-lg:fade-in-0 max-lg:slide-in-from-top max-lg:duration-[420ms]",
  webSheetEase,
);
const webExitTop = cn(
  "max-lg:data-[state=closed]:animate-out max-lg:data-[state=closed]:fade-out-0 max-lg:data-[state=closed]:slide-out-to-top max-lg:data-[state=closed]:duration-[280ms]",
);
const webEnterLeft = cn(
  "max-lg:animate-in max-lg:fade-in-0 max-lg:slide-in-from-left max-lg:duration-[380ms]",
  webSheetEase,
);
const webExitLeft = cn(
  "max-lg:data-[state=closed]:animate-out max-lg:data-[state=closed]:fade-out-0 max-lg:data-[state=closed]:slide-out-to-left max-lg:data-[state=closed]:duration-[260ms]",
);
const webEnterRight = cn(
  "max-lg:animate-in max-lg:fade-in-0 max-lg:slide-in-from-right max-lg:duration-[380ms]",
  webSheetEase,
);
const webExitRight = cn(
  "max-lg:data-[state=closed]:animate-out max-lg:data-[state=closed]:fade-out-0 max-lg:data-[state=closed]:slide-out-to-right max-lg:data-[state=closed]:duration-[260ms]",
);
const webLgCenterEnter = cn("lg:animate-in lg:fade-in-0 lg:zoom-in-95 lg:duration-200 lg:ease-out");
const webLgCenterExit = cn(
  "lg:data-[state=closed]:animate-out lg:data-[state=closed]:fade-out-0 lg:data-[state=closed]:zoom-out-95 lg:data-[state=closed]:duration-200",
);

const AlertModalVariants = cva(
  cn(
    "z-[51] flex w-full flex-col gap-4 border border-primary/5 bg-background p-6 shadow-lg",
    "overflow-y-auto",
    "lg:left-[50%] lg:top-[50%] lg:grid lg:w-full lg:max-w-lg lg:translate-x-[-50%] lg:translate-y-[-50%] lg:border lg:rounded-xl",
    Platform.select({
      web: cn(
        "fixed transition-[opacity,transform] ease-in-out",
        webLgCenterEnter,
        webLgCenterExit,
      ),
      native: "absolute",
    }),
  ),
  {
    variants: {
      side: {
        top: cn(
          "inset-x-0 top-0 max-h-[90%] rounded-b-xl border-b lg:h-fit",
          Platform.select({
            web: cn(webEnterTop, webExitTop),
          }),
        ),
        bottom: cn(
          "inset-x-0 bottom-0 max-h-[90%] rounded-t-xl border-t lg:bottom-auto lg:h-auto",
          Platform.select({
            web: cn(webEnterBottom, webExitBottom),
          }),
        ),
        left: cn(
          "inset-y-0 left-0 h-full w-3/4 rounded-r-xl border-r max-w-sm lg:h-fit",
          Platform.select({
            web: cn(webEnterLeft, webExitLeft),
          }),
        ),
        right: cn(
          "inset-y-0 right-0 h-full w-3/4 rounded-l-xl border-l max-w-sm lg:h-fit",
          Platform.select({
            web: cn(webEnterRight, webExitRight),
          }),
        ),
      },
      align: {
        center: "lg:left-[50%] lg:top-[50%] lg:translate-x-[-50%] lg:translate-y-[-50%]",
        left: "lg:left-0 lg:top-[50%] lg:mx-40 lg:translate-x-0 lg:translate-y-[-50%]",
        right:
          "lg:right-0 lg:left-auto lg:top-[50%] lg:mx-40 lg:translate-x-0 lg:translate-y-[-50%]",
        top: "lg:left-[50%] lg:top-0 lg:my-40 lg:translate-x-[-50%] lg:translate-y-0",
        "top-center": "lg:left-[50%] lg:top-0 lg:my-40 lg:translate-x-[-50%] lg:translate-y-0",
        bottom:
          "lg:left-[50%] lg:bottom-0 lg:top-auto lg:my-40 lg:translate-x-[-50%] lg:translate-y-0",
        "bottom-center":
          "lg:left-[50%] lg:bottom-0 lg:top-auto lg:my-40 lg:translate-x-[-50%] lg:translate-y-0",
        "top-left": "lg:left-0 lg:top-0 lg:m-40 lg:translate-x-0 lg:translate-y-0",
        "top-right": "lg:right-0 lg:left-auto lg:top-0 lg:m-40 lg:translate-x-0 lg:translate-y-0",
        "bottom-left":
          "lg:left-0 lg:bottom-0 lg:top-auto lg:m-40 lg:translate-x-0 lg:translate-y-0",
        "bottom-right":
          "lg:right-0 lg:bottom-0 lg:left-auto lg:top-auto lg:m-40 lg:translate-x-0 lg:translate-y-0",
      },
    },
    defaultVariants: {
      side: "bottom",
      align: "center",
    },
  },
);

type AlertModalSide = NonNullable<VariantProps<typeof AlertModalVariants>["side"]>;

const NATIVE_OPEN_MS = 400;
const NATIVE_CLOSE_MS = 280;

function nativeAlertModalEntering(side: AlertModalSide) {
  switch (side) {
    case "bottom":
      return FadeInUp.duration(NATIVE_OPEN_MS);
    case "top":
      return FadeInDown.duration(NATIVE_OPEN_MS);
    case "left":
      return FadeInLeft.duration(NATIVE_OPEN_MS);
    case "right":
      return FadeInRight.duration(NATIVE_OPEN_MS);
    default:
      return FadeInUp.duration(NATIVE_OPEN_MS);
  }
}

function nativeAlertModalExiting(side: AlertModalSide) {
  switch (side) {
    case "bottom":
      return FadeOutDown.duration(NATIVE_CLOSE_MS);
    case "top":
      return FadeOutUp.duration(NATIVE_CLOSE_MS);
    case "left":
      return FadeOutLeft.duration(NATIVE_CLOSE_MS);
    case "right":
      return FadeOutRight.duration(NATIVE_CLOSE_MS);
    default:
      return FadeOutDown.duration(NATIVE_CLOSE_MS);
  }
}

interface AlertModalContentProps
  extends
    React.ComponentProps<typeof AlertDialogPrimitive.Content>,
    VariantProps<typeof AlertModalVariants> {
  modalClassName?: string;
  portalHost?: string;
}

const AlertModalContentInner = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Content>,
  AlertModalContentProps
>(
  (
    {
      side = "bottom",
      align = "center",
      className,
      modalClassName,
      children,
      onOpenAutoFocus: onOpenAutoFocusProp,
      onCloseAutoFocus,
      onEscapeKeyDown,
      ...props
    },
    ref,
  ) => {
    const isMobile = useIsMobile();
    const { open } = AlertDialogPrimitive.useRootContext();

    const onOpenAutoFocus =
      Platform.OS === "web"
        ? (e: Event) => {
            if (side === "bottom" && isMobile) {
              e.preventDefault();
            }
            onOpenAutoFocusProp?.(e);
          }
        : undefined;

    const contentClassName = cn(
      AlertModalVariants({ side, align }),
      modalClassName,
      className,
      "rounded-xl rounded-b-none lg:rounded-b-xl",
    );

    const sheet: AlertModalSide = side ?? "bottom";

    if (Platform.OS === "web") {
      return (
        <AlertModalContentWeb
          ref={ref}
          className={contentClassName}
          dataSet={{ state: open ? "open" : "closed" }}
          onOpenAutoFocus={onOpenAutoFocus}
          onCloseAutoFocus={onCloseAutoFocus}
          onEscapeKeyDown={onEscapeKeyDown}
          {...props}
        >
          {children}
        </AlertModalContentWeb>
      );
    }

    return (
      <AlertDialogPrimitive.Content ref={ref} asChild {...props}>
        <NativeOnlyAnimatedView
          entering={nativeAlertModalEntering(sheet)}
          exiting={nativeAlertModalExiting(sheet)}
          className={contentClassName}
        >
          {children}
        </NativeOnlyAnimatedView>
      </AlertDialogPrimitive.Content>
    );
  },
);
AlertModalContentInner.displayName = "AlertModalContentInner";

const AlertModalContent = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Content>,
  AlertModalContentProps
>(({ portalHost, ...props }, ref) => (
  <AlertModalPortal hostName={portalHost}>
    <AlertModalOverlay />
    <AlertModalContentInner {...props} ref={ref} />
  </AlertModalPortal>
));
AlertModalContent.displayName = "AlertModalContent";

function AlertModalHeader({ className, ...props }: ViewProps) {
  return (
    <TextClassContext.Provider value="text-left">
      <View className={cn("flex flex-col gap-1", className)} {...props} />
    </TextClassContext.Provider>
  );
}
AlertModalHeader.displayName = "AlertModalHeader";

function AlertModalFooter({ className, ...props }: ViewProps) {
  return (
    <View
      className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  );
}
AlertModalFooter.displayName = "AlertModalFooter";

const AlertModalTitle = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Title
    ref={ref}
    className={cn("text-lg font-semibold text-foreground", className)}
    {...props}
  />
));
AlertModalTitle.displayName = "AlertModalTitle";

const AlertModalDescription = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
AlertModalDescription.displayName = "AlertModalDescription";

function AlertModalAction({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Action>) {
  return (
    <TextClassContext.Provider value={buttonTextVariants({ className })}>
      <AlertDialogPrimitive.Action className={cn(buttonVariants(), className)} {...props} />
    </TextClassContext.Provider>
  );
}

function AlertModalCancel({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Cancel>) {
  return (
    <TextClassContext.Provider value={buttonTextVariants({ className, variant: "outline" })}>
      <AlertDialogPrimitive.Cancel
        className={cn(buttonVariants({ variant: "outline" }), className)}
        {...props}
      />
    </TextClassContext.Provider>
  );
}

export {
  AlertModal,
  AlertModalAction,
  AlertModalCancel,
  AlertModalContent,
  AlertModalContentInner,
  AlertModalDescription,
  AlertModalFooter,
  AlertModalHeader,
  AlertModalOverlay,
  AlertModalPortal,
  AlertModalTitle,
  AlertModalTrigger,
};
