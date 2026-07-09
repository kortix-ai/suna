import { Icon } from "@/components/ui/icon";
import { NativeOnlyAnimatedView } from "@/components/ui/native-only-animated-view";
import { TextClassContext } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import * as ContextMenuPrimitive from "@rn-primitives/context-menu";
import { Check, ChevronDown, ChevronRight, ChevronUp } from "lucide-react-native";
import * as React from "react";
import { Platform, type StyleProp, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { FadeIn } from "react-native-reanimated";
import { FullWindowOverlay as RNFullWindowOverlay } from "react-native-screens";

const ContextMenu = ContextMenuPrimitive.Root;
const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
const ContextMenuGroup = ContextMenuPrimitive.Group;
const ContextMenuSub = ContextMenuPrimitive.Sub;
const ContextMenuRadioGroup = ContextMenuPrimitive.RadioGroup;

function ContextMenuSubTrigger({
  className,
  inset,
  children,
  iconClassName,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubTrigger> & {
  children?: React.ReactNode;
  iconClassName?: string;
  inset?: boolean;
}) {
  const { open } = ContextMenuPrimitive.useSubContext();
  const icon = Platform.OS === "web" ? ChevronRight : open ? ChevronUp : ChevronDown;
  return (
    <TextClassContext.Provider
      value={cn(
        "text-sm select-none group-active:text-accent-foreground",
        open && "text-accent-foreground",
      )}
    >
      <ContextMenuPrimitive.SubTrigger
        className={cn(
          "group flex flex-row items-center rounded-sm px-2 py-2 active:bg-accent sm:py-1.5",
          Platform.select({
            web: "cursor-default outline-none focus:bg-accent focus:text-accent-foreground [&_svg]:pointer-events-none",
          }),
          className,
          open && cn("bg-accent", Platform.select({ native: "mb-1" })),
          inset && "pl-8",
        )}
        {...props}
      >
        <>{children}</>
        <Icon as={icon} className={cn("ml-auto size-4 shrink-0 text-foreground", iconClassName)} />
      </ContextMenuPrimitive.SubTrigger>
    </TextClassContext.Provider>
  );
}

function ContextMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubContent>) {
  return (
    <NativeOnlyAnimatedView entering={FadeIn}>
      <ContextMenuPrimitive.SubContent
        className={cn(
          "overflow-hidden rounded-md border border-border bg-popover p-1 shadow-lg shadow-black/5",
          Platform.select({
            web: "origin-(--radix-context-menu-content-transform-origin) z-50 min-w-[8rem] animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
          }),
          className,
        )}
        {...props}
      />
    </NativeOnlyAnimatedView>
  );
}

const FullWindowOverlay = Platform.OS === "ios" ? RNFullWindowOverlay : React.Fragment;

function ContextMenuContent({
  className,
  overlayClassName,
  overlayStyle,
  portalHost,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content> & {
  overlayStyle?: StyleProp<ViewStyle>;
  overlayClassName?: string;
  portalHost?: string;
}) {
  return (
    <ContextMenuPrimitive.Portal hostName={portalHost}>
      <FullWindowOverlay>
        <ContextMenuPrimitive.Overlay
          style={Platform.select({
            web: overlayStyle ?? undefined,
            native: overlayStyle
              ? StyleSheet.flatten([
                  StyleSheet.absoluteFill,
                  overlayStyle as typeof StyleSheet.absoluteFill,
                ])
              : StyleSheet.absoluteFill,
          })}
          className={overlayClassName}
        >
          <NativeOnlyAnimatedView entering={FadeIn}>
            <TextClassContext.Provider value="text-popover-foreground">
              <ContextMenuPrimitive.Content
                className={cn(
                  "min-w-[8rem] overflow-hidden rounded-md border border-border bg-popover p-1 shadow-lg shadow-black/5",
                  Platform.select({
                    web: cn(
                      "max-h-(--radix-context-menu-content-available-height) origin-(--radix-context-menu-content-transform-origin) z-50 cursor-default animate-in fade-in-0 zoom-in-95",
                      props.side === "bottom" && "slide-in-from-top-2",
                      props.side === "top" && "slide-in-from-bottom-2",
                    ),
                  }),
                  className,
                )}
                {...props}
              />
            </TextClassContext.Provider>
          </NativeOnlyAnimatedView>
        </ContextMenuPrimitive.Overlay>
      </FullWindowOverlay>
    </ContextMenuPrimitive.Portal>
  );
}

function ContextMenuItem({
  className,
  inset,
  variant,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & {
  className?: string;
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  return (
    <TextClassContext.Provider
      value={cn(
        "select-none text-sm text-popover-foreground group-active:text-popover-foreground",
        variant === "destructive" && "text-destructive group-active:text-destructive",
      )}
    >
      <ContextMenuPrimitive.Item
        className={cn(
          "group relative flex flex-row items-center gap-2 rounded-sm px-2 py-2 active:bg-accent sm:py-1.5",
          Platform.select({
            web: cn(
              "cursor-default outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none",
              variant === "destructive" && "focus:bg-destructive/10 dark:focus:bg-destructive/20",
            ),
          }),
          variant === "destructive" && "active:bg-destructive/10 dark:active:bg-destructive/20",
          props.disabled && "opacity-50",
          inset && "pl-8",
          className,
        )}
        {...props}
      />
    </TextClassContext.Provider>
  );
}

function ContextMenuCheckboxItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.CheckboxItem> & {
  children?: React.ReactNode;
}) {
  return (
    <TextClassContext.Provider value="text-sm text-popover-foreground select-none group-active:text-accent-foreground">
      <ContextMenuPrimitive.CheckboxItem
        className={cn(
          "group relative flex flex-row items-center gap-2 rounded-sm py-2 pl-8 pr-2 active:bg-accent sm:py-1.5",
          Platform.select({
            web: "cursor-default outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none",
          }),
          props.disabled && "opacity-50",
          className,
        )}
        {...props}
      >
        <View className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
          <ContextMenuPrimitive.ItemIndicator>
            <Icon
              as={Check}
              className={cn(
                "size-4 text-foreground",
                Platform.select({ web: "pointer-events-none" }),
              )}
            />
          </ContextMenuPrimitive.ItemIndicator>
        </View>
        <>{children}</>
      </ContextMenuPrimitive.CheckboxItem>
    </TextClassContext.Provider>
  );
}

function ContextMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.RadioItem> & {
  children?: React.ReactNode;
}) {
  return (
    <TextClassContext.Provider value="text-sm text-popover-foreground select-none group-active:text-accent-foreground">
      <ContextMenuPrimitive.RadioItem
        className={cn(
          "group relative flex flex-row items-center gap-2 rounded-sm py-2 pl-8 pr-2 active:bg-accent sm:py-1.5",
          Platform.select({
            web: "cursor-default outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none",
          }),
          props.disabled && "opacity-50",
          className,
        )}
        {...props}
      >
        <View className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
          <ContextMenuPrimitive.ItemIndicator>
            <View className="h-2 w-2 rounded-full bg-foreground" />
          </ContextMenuPrimitive.ItemIndicator>
        </View>
        <>{children}</>
      </ContextMenuPrimitive.RadioItem>
    </TextClassContext.Provider>
  );
}

function ContextMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Label> & {
  className?: string;
  inset?: boolean;
}) {
  return (
    <ContextMenuPrimitive.Label
      className={cn(
        "px-2 py-2 text-sm font-medium text-foreground sm:py-1.5",
        inset && "pl-8",
        className,
      )}
      {...props}
    />
  );
}

function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return (
    <ContextMenuPrimitive.Separator
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

function ContextMenuShortcut({ className, ...props }: React.ComponentProps<typeof Text>) {
  return (
    <Text
      className={cn("ml-auto text-xs tracking-widest text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
};
