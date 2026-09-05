import { TextClassContext } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import * as TabsPrimitive from "@rn-primitives/tabs";
import * as React from "react";
import { Platform } from "react-native";

export type TabsVariant = "default" | "transparent" | "underline";

const TabsVariantContext = React.createContext<TabsVariant>("default");

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root className={cn("flex flex-col gap-2", className)} {...props} />;
}

type TabsListProps = React.ComponentProps<typeof TabsPrimitive.List> & {
  variant?: TabsVariant;
};

function TabsList({ className, variant = "default", ...props }: TabsListProps) {
  return (
    <TabsVariantContext.Provider value={variant}>
      <TabsPrimitive.List
        className={cn(
          "flex flex-row items-center justify-center rounded-lg",
          variant === "default" && "h-9 bg-muted p-[3px]",
          variant === "transparent" && "h-9 bg-transparent p-0",
          variant === "underline" &&
            "h-auto gap-6 rounded-none border-b border-border bg-transparent p-0",
          Platform.select({ web: "inline-flex w-fit", native: "mr-auto" }),
          className,
        )}
        {...props}
      />
    </TabsVariantContext.Provider>
  );
}

type TabsTriggerProps = React.ComponentProps<typeof TabsPrimitive.Trigger> & {
  variant?: TabsVariant;
};

function TabsTrigger({ className, variant: variantProp, ...props }: TabsTriggerProps) {
  const { value } = TabsPrimitive.useRootContext();
  const listVariant = React.useContext(TabsVariantContext);
  const variant = variantProp ?? listVariant;
  const isActive = props.value === value;

  const triggerTextClass =
    variant === "transparent"
      ? cn("text-sm font-medium", isActive ? "text-primary" : "text-muted-foreground")
      : variant === "underline"
        ? cn("text-sm font-medium", isActive ? "text-foreground" : "text-muted-foreground")
        : cn(
            "text-foreground text-sm font-medium dark:text-muted-foreground",
            isActive && "dark:text-foreground",
          );

  return (
    <TextClassContext.Provider value={triggerTextClass}>
      <TabsPrimitive.Trigger
        className={cn(
          "flex flex-row items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1",
          variant !== "underline" && "h-[calc(100%-1px)]",
          variant === "default" && "shadow-none shadow-black/5",
          variant === "transparent" && "bg-transparent shadow-none",
          variant === "underline" &&
            "mb-[-1px] h-auto rounded-none border-0 border-b-2 bg-transparent px-1 py-2 shadow-none",
          variant === "underline" && (isActive ? "border-primary" : "border-transparent"),
          Platform.select({
            web: "inline-flex cursor-default whitespace-nowrap transition-[color,box-shadow] focus-visible:border-ring focus-visible:outline-1 focus-visible:outline-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0",
          }),
          props.disabled && "opacity-50",
          variant === "default" &&
            isActive &&
            "bg-background dark:border-foreground/10 dark:bg-input/30",
          variant === "transparent" && isActive && "dark:border-transparent",
          className,
        )}
        {...props}
      />
    </TextClassContext.Provider>
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      className={cn("flex-1", Platform.select({ web: "outline-none", default: "" }), className)}
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
