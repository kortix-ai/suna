import { NativeOnlyAnimatedView } from "@/components/ui/native-only-animated-view";
import { TextClassContext } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import * as HoverCardPrimitive from "@rn-primitives/hover-card";
import * as React from "react";
import { Platform, StyleSheet } from "react-native";
import { FadeIn, FadeOut } from "react-native-reanimated";
import { FullWindowOverlay as RNFullWindowOverlay } from "react-native-screens";

const HoverCard = HoverCardPrimitive.Root;

const HoverCardTrigger = HoverCardPrimitive.Trigger;

const FullWindowOverlay = Platform.OS === "ios" ? RNFullWindowOverlay : React.Fragment;

function HoverCardContent({
  className,
  align = "center",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content>) {
  return (
    <HoverCardPrimitive.Portal>
      <FullWindowOverlay>
        <HoverCardPrimitive.Overlay style={Platform.select({ native: StyleSheet.absoluteFill })}>
          <NativeOnlyAnimatedView entering={FadeIn} exiting={FadeOut}>
            <TextClassContext.Provider value="text-popover-foreground">
              <HoverCardPrimitive.Content
                align={align}
                sideOffset={sideOffset}
                className={cn(
                  "outline-hidden z-50 w-64 rounded-md border border-border bg-popover p-4 shadow-md shadow-black/5",
                  Platform.select({
                    web: cn(
                      "origin-(--radix-hover-card-content-transform-origin) cursor-default animate-in fade-in-0 zoom-in-95 [&>*]:cursor-auto",
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
        </HoverCardPrimitive.Overlay>
      </FullWindowOverlay>
    </HoverCardPrimitive.Portal>
  );
}

export { HoverCard, HoverCardContent, HoverCardTrigger };
