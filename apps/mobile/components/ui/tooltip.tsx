import { NativeOnlyAnimatedView } from "@/components/ui/native-only-animated-view";
import { TextClassContext } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import * as TooltipPrimitive from "@rn-primitives/tooltip";
import * as React from "react";
import { Platform, StyleSheet } from "react-native";
import { FadeInDown, FadeInUp, FadeOut } from "react-native-reanimated";
import { FullWindowOverlay as RNFullWindowOverlay } from "react-native-screens";

const Tooltip = TooltipPrimitive.Root;

const TooltipTrigger = TooltipPrimitive.Trigger;

const FullWindowOverlay = Platform.OS === "ios" ? RNFullWindowOverlay : React.Fragment;

function TooltipContent({
  className,
  sideOffset = 4,
  portalHost,
  side = "top",
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content> & {
  portalHost?: string;
}) {
  return (
    <TooltipPrimitive.Portal hostName={portalHost}>
      <FullWindowOverlay>
        <TooltipPrimitive.Overlay style={Platform.select({ native: StyleSheet.absoluteFill })}>
          <NativeOnlyAnimatedView
            entering={
              side === "top"
                ? FadeInDown.withInitialValues({ transform: [{ translateY: 3 }] }).duration(150)
                : FadeInUp.withInitialValues({ transform: [{ translateY: -5 }] })
            }
            exiting={FadeOut}
          >
            <TextClassContext.Provider value="text-xs text-primary-foreground">
              <TooltipPrimitive.Content
                sideOffset={sideOffset}
                className={cn(
                  "z-50 rounded-md bg-primary px-3 py-2 sm:py-1.5",
                  Platform.select({
                    web: cn(
                      "origin-(--radix-tooltip-content-transform-origin) w-fit text-balance animate-in fade-in-0 zoom-in-95",
                      side === "bottom" && "slide-in-from-top-2",
                      side === "left" && "slide-in-from-right-2",
                      side === "right" && "slide-in-from-left-2",
                      side === "top" && "slide-in-from-bottom-2",
                    ),
                  }),
                  className,
                )}
                side={side}
                {...props}
              />
            </TextClassContext.Provider>
          </NativeOnlyAnimatedView>
        </TooltipPrimitive.Overlay>
      </FullWindowOverlay>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipTrigger };
