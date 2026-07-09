import { cn } from "@/lib/utils";
import { Platform, TextInput } from "react-native";

type InputProps = React.ComponentProps<typeof TextInput> & {
  variant?: "default" | "transparent";
};

function Input({ className, variant = "default", ...props }: InputProps) {
  return (
    <TextInput
      className={cn(
        "flex h-11 w-full min-w-0 flex-row items-center rounded-md  bg-card p-3 px-4  text-[0.9rem] leading-5 text-foreground shadow-sm shadow-black/5",
        variant === "transparent" &&
          "flex h-10 w-full min-w-0 flex-row items-center rounded-md border border-border bg-transparent px-3 py-1 text-base leading-5 text-foreground shadow-sm shadow-black/5  sm:h-9",
        props.editable === false &&
          cn(
            "opacity-50",
            Platform.select({ web: "disabled:pointer-events-none disabled:cursor-not-allowed" }),
          ),
        Platform.select({
          web: cn(
            "outline-none transition-[color,box-shadow] selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground md:text-sm",
            "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
            "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
          ),
          native: "placeholder:text-muted-foreground/50",
        }),
        className,
      )}
      {...props}
    />
  );
}

export { Input };
