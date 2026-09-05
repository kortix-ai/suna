import { Icon } from "@/components/ui/icon";
import { TextClassContext } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import * as DropdownMenuPrimitive from "@rn-primitives/dropdown-menu";
import { Check, ChevronDown, ChevronRight, ChevronUp } from "lucide-react-native";
import * as React from "react";
import { Platform, type StyleProp, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { FullWindowOverlay as RNFullWindowOverlay } from "react-native-screens";

const DropdownMenu = DropdownMenuPrimitive.Root;

const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

const DropdownMenuGroup = (props: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) => (
  <DropdownMenuPrimitive.Group
    {...props}
    className={cn("rounded-2xl bg-secondary/50", props.className)}
  />
);

const DropdownMenuPortal = DropdownMenuPrimitive.Portal;

const DropdownMenuSub = DropdownMenuPrimitive.Sub;

const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  iconClassName,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & {
  children?: React.ReactNode;
  iconClassName?: string;
  inset?: boolean;
}) {
  const { open } = DropdownMenuPrimitive.useSubContext();
  const icon = Platform.OS === "web" ? ChevronRight : open ? ChevronUp : ChevronDown;
  return (
    <TextClassContext.Provider
      value={cn(
        "text-sm select-none group-active:text-accent-foreground",
        open && "text-accent-foreground",
      )}
    >
      <DropdownMenuPrimitive.SubTrigger
        className={cn(
          "group flex flex-row items-center rounded-sm px-2 py-2 active:bg-accent sm:py-1.5",
          Platform.select({
            web: "cursor-default outline-none focus:bg-accent focus:text-accent-foreground [&_svg]:pointer-events-none",
          }),
          className,
          open && "bg-accent",
          inset && "pl-8",
        )}
        {...props}
      >
        <>{children}</>
        <Icon as={icon} className={cn("ml-auto size-4 shrink-0 text-foreground", iconClassName)} />
      </DropdownMenuPrimitive.SubTrigger>
    </TextClassContext.Provider>
  );
}

function DropdownMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <DropdownMenuPrimitive.SubContent
      className={cn(
        "overflow-hidden rounded-md border border-border bg-card p-1 shadow-lg shadow-black/5",
        Platform.select({
          web: "origin-(--radix-context-menu-content-transform-origin) z-50 min-w-[8rem] animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
        }),
        className,
      )}
      {...props}
    />
  );
}

const FullWindowOverlay = Platform.OS === "ios" ? RNFullWindowOverlay : React.Fragment;

const webSheetEase = "ease-[cubic-bezier(0.32,0.72,0,1)]";
const webSheetBottom = cn(
  "animate-in fade-in-0 slide-in-from-bottom duration-[420ms]",
  webSheetEase,
);

function DropdownMenuContent({
  className,
  overlayClassName,
  overlayStyle,
  portalHost,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content> & {
  overlayStyle?: StyleProp<ViewStyle>;
  overlayClassName?: string;
  portalHost?: string;
}) {
  return (
    <DropdownMenuPrimitive.Portal hostName={portalHost}>
      <FullWindowOverlay>
        <DropdownMenuPrimitive.Overlay
          style={Platform.select({
            web: overlayStyle ?? undefined,
            native: overlayStyle
              ? StyleSheet.flatten([
                  StyleSheet.absoluteFill,
                  overlayStyle as typeof StyleSheet.absoluteFill,
                ])
              : StyleSheet.absoluteFill,
          })}
          className={cn(
            "absolute inset-0 bottom-0 z-50 w-full ",
            Platform.select({
              web: "absolute inset-0 bottom-0 z-50 cursor-default bg-black/60 dark:bg-black/85 [&>*]:cursor-auto",
              native: "bg-transparent",
            }),
            overlayClassName,
          )}
        >
          {Platform.OS !== "web" ? (
            <View
              className="absolute inset-0 z-0 bg-black/60 dark:bg-black/85"
              pointerEvents="none"
            />
          ) : null}
          <View
            className="absolute inset-0 bottom-4 z-[51] flex w-full flex-col justify-end"
            pointerEvents="box-none"
          >
            <View className="max-h-[90%] w-full min-w-0 shrink-0 p-4" pointerEvents="box-none">
              <TextClassContext.Provider value="text-foreground">
                <DropdownMenuPrimitive.Content
                  disablePositioningStyle
                  {...props}
                  className={cn(
                    "max-h-full w-full min-w-full shrink-0 overflow-hidden overflow-y-auto rounded-3xl border border-primary/5 bg-background p-1 shadow-lg",
                    Platform.select({
                      web: cn("cursor-default", webSheetBottom),
                    }),
                    className,
                  )}
                />
              </TextClassContext.Provider>
            </View>
          </View>
        </DropdownMenuPrimitive.Overlay>
      </FullWindowOverlay>
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuItem({
  className,
  inset,
  variant,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  className?: string;
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  return (
    <TextClassContext.Provider
      value={cn(
        "select-none text-sm text-card-foreground group-active:text-card-foreground",
        variant === "destructive" && "text-destructive group-active:text-destructive",
      )}
    >
      <DropdownMenuPrimitive.Item
        className={cn(
          "group relative flex flex-row items-center gap-2 rounded-2xl p-3 active:bg-accent",
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

function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem> & {
  children?: React.ReactNode;
}) {
  return (
    <TextClassContext.Provider value="text-sm text-card-foreground select-none group-active:text-accent-foreground">
      <DropdownMenuPrimitive.CheckboxItem
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
          <DropdownMenuPrimitive.ItemIndicator>
            <Icon
              as={Check}
              className={cn(
                "size-4 text-foreground",
                Platform.select({ web: "pointer-events-none" }),
              )}
            />
          </DropdownMenuPrimitive.ItemIndicator>
        </View>
        <>{children}</>
      </DropdownMenuPrimitive.CheckboxItem>
    </TextClassContext.Provider>
  );
}

function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem> & {
  children?: React.ReactNode;
}) {
  return (
    <TextClassContext.Provider value="text-sm text-card-foreground select-none group-active:text-accent-foreground">
      <DropdownMenuPrimitive.RadioItem
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
        <>{children}</>
        <View className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
          <DropdownMenuPrimitive.ItemIndicator>
            <View className="h-2 w-2 rounded-full bg-foreground" />
          </DropdownMenuPrimitive.ItemIndicator>
        </View>
      </DropdownMenuPrimitive.RadioItem>
    </TextClassContext.Provider>
  );
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & {
  className?: string;
  inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.Label
      className={cn(
        "px-2 py-2 text-sm font-medium text-foreground sm:py-1.5",
        inset && "pl-8",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<typeof Text>) {
  return (
    <Text
      className={cn("ml-auto text-xs tracking-widest text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
};
