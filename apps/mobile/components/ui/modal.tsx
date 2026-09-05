import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { NativeOnlyAnimatedView } from "@/components/ui/native-only-animated-view";
import { useIsMobile } from "@/hooks/use-mobile";
// import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import * as DialogPrimitive from "@rn-primitives/dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react-native";
import * as React from "react";
import { ActivityIndicator, Platform, Text, View, type ViewProps } from "react-native";
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

const Modal = ({ onOpenChange, ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) => {
  return <DialogPrimitive.Root onOpenChange={onOpenChange} {...props} />;
};

const ModalTrigger = DialogPrimitive.Trigger;

const ModalClose = DialogPrimitive.Close;

const ModalPortal = DialogPrimitive.Portal;

const FullWindowOverlay = Platform.OS === "ios" ? RNFullWindowOverlay : React.Fragment;

type ModalOverlayProps = React.ComponentProps<typeof DialogPrimitive.Overlay> & {
  /** When false, tapping the backdrop does not close the modal (native). */
  closeOnPress?: boolean;
};

const ModalOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  ModalOverlayProps
>(({ className, closeOnPress = true, ...props }, ref) => (
  <FullWindowOverlay>
    <DialogPrimitive.Overlay
      ref={ref}
      closeOnPress={closeOnPress}
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
    </DialogPrimitive.Overlay>
  </FullWindowOverlay>
));
ModalOverlay.displayName = "ModalOverlay";

/** Web-only: RN `View` types omit `dataSet`; Radix exit animations need `data-state` on this node. */
const ModalContentWeb = DialogPrimitive.Content as React.ComponentType<
  React.ComponentProps<typeof DialogPrimitive.Content> & {
    dataSet?: { state: "open" | "closed" };
  }
>;

const webSheetEase = "max-lg:ease-[cubic-bezier(0.32,0.72,0,1)]";

/** Web: Radix wraps our View, so `data-state` may live on a parent — use unconditional `animate-in` for enter (like `dialog.tsx`) and keep exit utilities when `data-state` is forwarded to the RN view. */
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

const ModalVariants = cva(
  cn(
    "z-[51] gap-0 border border-primary/5 bg-background p-0 shadow-lg",
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

type ModalSide = NonNullable<VariantProps<typeof ModalVariants>["side"]>;

const NATIVE_OPEN_MS = 400;
const NATIVE_CLOSE_MS = 280;

/**
 * Reanimated names these for the edge the view travels *from*: `FadeInDown`
 * starts at `translateY: +25` (below) and rises. A bottom sheet must therefore
 * enter with `FadeInDown` — pairing it with the `FadeOutDown` exit below.
 */
function nativeModalEntering(side: ModalSide) {
  switch (side) {
    case "bottom":
      return FadeInDown.duration(NATIVE_OPEN_MS);
    case "top":
      return FadeInUp.duration(NATIVE_OPEN_MS);
    case "left":
      return FadeInLeft.duration(NATIVE_OPEN_MS);
    case "right":
      return FadeInRight.duration(NATIVE_OPEN_MS);
    default:
      return FadeInDown.duration(NATIVE_OPEN_MS);
  }
}

function nativeModalExiting(side: ModalSide) {
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

interface ModalContentProps
  extends React.ComponentProps<typeof DialogPrimitive.Content>, VariantProps<typeof ModalVariants> {
  closeClassName?: string;
  modalClassName?: string;
  showCloseButton?: boolean;
  closeOnOutsideClick?: boolean;
  portalHost?: string;
}

const ModalContentInner = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  ModalContentProps
>(
  (
    {
      side = "bottom",
      align = "center",
      className,
      modalClassName,
      closeClassName,
      children,
      showCloseButton = false,
      closeOnOutsideClick = true,
      onOpenAutoFocus: onOpenAutoFocusProp,
      onPointerDownOutside: onPointerDownOutsideProp,
      onCloseAutoFocus,
      onEscapeKeyDown,
      onInteractOutside,
      ...props
    },
    ref,
  ) => {
    const isMobile = useIsMobile();
    const { open } = DialogPrimitive.useRootContext();

    const onOpenAutoFocus =
      Platform.OS === "web"
        ? (e: Event) => {
            if (side === "bottom" && isMobile) {
              e.preventDefault();
            }
            onOpenAutoFocusProp?.(e);
          }
        : undefined;

    const onPointerDownOutside =
      Platform.OS === "web"
        ? closeOnOutsideClick
          ? onPointerDownOutsideProp
          : (e: Event) => {
              e.preventDefault();
              onPointerDownOutsideProp?.(e);
            }
        : undefined;

    const contentClassName = cn(
      ModalVariants({ side, align }),
      modalClassName,
      className,
      "rounded-xl rounded-b-none lg:rounded-b-xl",
    );

    const sheet: ModalSide = side ?? "bottom";

    const closeButton = showCloseButton && (
      <ModalClose asChild>
        <Button
          variant="ghost"
          className={cn(
            "absolute right-4 top-4 z-40 h-8 w-8 rounded-md p-0 text-xs font-semibold text-primary web:transition-colors web:hover:text-primary web:focus:outline-none",
            closeClassName,
          )}
          hitSlop={12}
        >
          <Icon as={X} className={cn("size-5 shrink-0 text-primary web:pointer-events-none")} />
          <Text className="sr-only">Close</Text>
        </Button>
      </ModalClose>
    );

    if (Platform.OS === "web") {
      return (
        <ModalContentWeb
          ref={ref}
          className={contentClassName}
          dataSet={{ state: open ? "open" : "closed" }}
          onOpenAutoFocus={onOpenAutoFocus}
          onPointerDownOutside={onPointerDownOutside}
          onCloseAutoFocus={onCloseAutoFocus}
          onEscapeKeyDown={onEscapeKeyDown}
          onInteractOutside={onInteractOutside}
          {...props}
        >
          {children}
          {closeButton}
        </ModalContentWeb>
      );
    }

    return (
      <DialogPrimitive.Content ref={ref} asChild {...props}>
        <NativeOnlyAnimatedView
          entering={nativeModalEntering(sheet)}
          exiting={nativeModalExiting(sheet)}
          className={contentClassName}
        >
          {children}
          {closeButton}
        </NativeOnlyAnimatedView>
      </DialogPrimitive.Content>
    );
  },
);
ModalContentInner.displayName = "ModalContentInner";

const ModalContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  ModalContentProps
>(({ portalHost, closeOnOutsideClick = true, ...props }, ref) => (
  <ModalPortal hostName={portalHost}>
    <ModalOverlay closeOnPress={closeOnOutsideClick} />
    <ModalContentInner {...props} ref={ref} closeOnOutsideClick={closeOnOutsideClick} />
  </ModalPortal>
));
ModalContent.displayName = "ModalContent";

const ModalHeader = ({ className, ...props }: ViewProps) => (
  <View className={cn("flex flex-col space-y-0 text-left", "px-5 pt-5", className)} {...props} />
);
ModalHeader.displayName = "ModalHeader";

const ModalBody = ({ className, ...props }: ViewProps) => (
  <View className={cn("flex-1 space-y-4 p-5", className)} {...props} />
);
ModalBody.displayName = "ModalBody";

const ModalFooter = ({ className, ...props }: ViewProps) => (
  <View
    className={cn(
      "flex w-full flex-col-reverse items-center justify-end gap-y-2 space-x-2  rounded-b-none md:rounded-b-xl lg:rounded-b-xl",
      className,
    )}
    {...props}
  />
);
ModalFooter.displayName = "ModalFooter";

const ModalTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-base font-semibold text-foreground", className)}
    {...props}
  />
));
ModalTitle.displayName = "ModalTitle";

const ModalDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
ModalDescription.displayName = "ModalDescription";

function ModalLoadingContent() {
  const webOnly =
    Platform.OS === "web" ? ({ autoFocus: false, "aria-describedby": undefined } as const) : {};

  return (
    <ModalContentInner
      className="min-h-[300px] items-center justify-center"
      closeOnOutsideClick={false}
      showCloseButton={false}
      {...webOnly}
    >
      <ModalTitle className="sr-only">Loading</ModalTitle>
      <View className="flex flex-col items-center gap-4">
        <ActivityIndicator className="text-primary" />
        <Text className="text-sm text-muted-foreground">Loading content...</Text>
      </View>
    </ModalContentInner>
  );
}

const LazyModal = ({
  children,
  open,
  forceMount,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root> & { forceMount?: boolean }) => {
  const [hasOpened, setHasOpened] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setHasOpened(true);
    }
  }, [open]);

  if (!hasOpened && !forceMount) return null;

  return (
    <Modal open={open} {...props}>
      <ModalPortal>
        <ModalOverlay />
        <React.Suspense fallback={<ModalLoadingContent />}>{children}</React.Suspense>
      </ModalPortal>
    </Modal>
  );
};

LazyModal.displayName = "LazyModal";

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
