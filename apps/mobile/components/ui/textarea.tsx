import { cn } from "@/lib/utils";
import { Platform, TextInput } from "react-native";

function Textarea({
  className,
  multiline = true,
  numberOfLines = Platform.select({ web: 2, native: 8 }), // On web, numberOfLines also determines initial height. On native, it determines the maximum height.
  placeholderClassName,
  ...props
}: React.ComponentProps<typeof TextInput>) {
  return (
    <TextInput
      className={cn(
        "flex min-h-24 w-full flex-row rounded-2xl  bg-card p-3 px-4  text-[0.9rem] leading-5 text-foreground shadow-sm shadow-black/5 ",
        Platform.select({
          web: "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive field-sizing-content resize-y outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed",
        }),
        props.editable === false && "opacity-50",
        className,
      )}
      placeholderClassName={cn("text-muted-foreground", placeholderClassName)}
      multiline={multiline}
      numberOfLines={numberOfLines}
      textAlignVertical="top"
      {...props}
    />
  );
}

export { Textarea };
