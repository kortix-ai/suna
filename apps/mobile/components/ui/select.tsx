import { buttonTextVariants, buttonVariants } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { TextClassContext } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import * as SelectPrimitive from "@rn-primitives/select";
import { type VariantProps } from "class-variance-authority";
import { Check, ChevronDown, ChevronDownIcon, ChevronUpIcon } from "lucide-react-native";
import * as React from "react";
import { Platform, type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import { FullWindowOverlay as RNFullWindowOverlay } from "react-native-screens";

type Option = SelectPrimitive.Option;

const Select = SelectPrimitive.Root;

const SelectGroup = SelectPrimitive.Group;

function SelectValue({
  ref,
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Value> & {
  className?: string;
}) {
  const { value } = SelectPrimitive.useRootContext();
  const textClass = React.useContext(TextClassContext);
  return (
    <SelectPrimitive.Value
      ref={ref}
      className={cn(
        "line-clamp-1 flex flex-row items-center gap-2 text-sm font-medium",
        textClass ?? "text-foreground",
        !value && "text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function selectTriggerChevronClass(
  variant: VariantProps<typeof buttonVariants>["variant"],
): string {
  switch (variant ?? "default") {
    case "destructive":
      return "text-white/80";
    case "default":
      return "text-primary-foreground/80";
    case "secondary":
      return "text-secondary-foreground/70";
    case "accent":
      return "text-accent-foreground/80";
    case "card":
      return "text-card-foreground/70";
    case "link":
      return "text-primary/80";
    default:
      return "text-muted-foreground";
  }
}

function SelectTrigger({
  ref,
  className,
  children,
  variant = "secondary",
  size = "default",
  content,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & VariantProps<typeof buttonVariants>) {
  return (
    <TextClassContext.Provider value={buttonTextVariants({ variant, size })}>
      <SelectPrimitive.Trigger
        ref={ref}
        className={cn(
          props.disabled && "opacity-50",
          buttonVariants({ variant, size, content }),
          "min-w-0 justify-between",
          Platform.select({
            web: "w-fit whitespace-nowrap disabled:cursor-not-allowed",
          }),
          className,
        )}
        {...props}
      >
        <>{children}</>
        <Icon
          as={ChevronDown}
          aria-hidden={true}
          className={cn("size-4 shrink-0", selectTriggerChevronClass(variant))}
        />
      </SelectPrimitive.Trigger>
    </TextClassContext.Provider>
  );
}

const FullWindowOverlay = Platform.OS === "ios" ? RNFullWindowOverlay : React.Fragment;

const webSheetEase = "ease-[cubic-bezier(0.32,0.72,0,1)]";
const webSheetBottom = cn(
  "animate-in fade-in-0 slide-in-from-bottom duration-[420ms]",
  webSheetEase,
);

function SelectContent({
  className,
  children,
  position = "popper",
  portalHost,
  overlayClassName,
  overlayStyle,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content> & {
  className?: string;
  portalHost?: string;
  overlayClassName?: string;
  overlayStyle?: StyleProp<ViewStyle>;
}) {
  return (
    <SelectPrimitive.Portal hostName={portalHost}>
      <FullWindowOverlay>
        <SelectPrimitive.Overlay
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
            "absolute inset-0 bottom-0 z-50 w-full",
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
                <SelectPrimitive.Content
                  disablePositioningStyle
                  position={position}
                  {...props}
                  className={cn(
                    "max-h-full w-full min-w-full shrink-0 overflow-hidden overflow-y-auto rounded-2xl border border-primary/5 bg-background p-1 shadow-lg",
                    Platform.select({
                      web: cn("cursor-default", webSheetBottom),
                    }),
                    className,
                  )}
                >
                  <SelectScrollUpButton />
                  <SelectPrimitive.Viewport className={cn("w-full p-1")}>
                    {children}
                  </SelectPrimitive.Viewport>
                  <SelectScrollDownButton />
                </SelectPrimitive.Content>
              </TextClassContext.Provider>
            </View>
          </View>
        </SelectPrimitive.Overlay>
      </FullWindowOverlay>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      className={cn("px-2 py-2 text-xs text-muted-foreground sm:py-1.5", className)}
      {...props}
    />
  );
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cn(
        "group relative flex w-full flex-row items-center gap-2 rounded-xl p-3 active:bg-accent",
        Platform.select({
          web: "*:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2 cursor-default outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none [&_svg]:pointer-events-none",
        }),
        props.disabled && "opacity-50",
        className,
      )}
      {...props}
    >
      <View className="absolute right-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Icon as={Check} className="size-4 shrink-0 text-muted-foreground" />
        </SelectPrimitive.ItemIndicator>
      </View>
      <SelectPrimitive.ItemText className="select-none text-sm text-foreground group-active:text-accent-foreground" />
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      className={cn(
        "-mx-1 my-1 h-px bg-border",
        Platform.select({ web: "pointer-events-none" }),
        className,
      )}
      {...props}
    />
  );
}

/**
 * @platform Web only
 * Returns null on native platforms
 */
function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  if (Platform.OS !== "web") {
    return null;
  }
  return (
    <SelectPrimitive.ScrollUpButton
      className={cn("flex cursor-default items-center justify-center py-1", className)}
      {...props}
    >
      <Icon as={ChevronUpIcon} className="size-4" />
    </SelectPrimitive.ScrollUpButton>
  );
}

/**
 * @platform Web only
 * Returns null on native platforms
 */
function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  if (Platform.OS !== "web") {
    return null;
  }
  return (
    <SelectPrimitive.ScrollDownButton
      className={cn("flex cursor-default items-center justify-center py-1", className)}
      {...props}
    >
      <Icon as={ChevronDownIcon} className="size-4" />
    </SelectPrimitive.ScrollDownButton>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  type Option,
};
