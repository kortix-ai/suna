import { cn } from "@/lib/utils"

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "bg-muted text-muted-foreground pointer-events-none inline-flex h-5 w-fit min-w-5 items-center justify-center gap-1 rounded-sm px-1 font-sans text-xs font-medium select-none",
        "[&_svg:not([class*='size-'])]:size-3",
        "[[data-slot=tooltip-content]_&]:bg-background/20 [[data-slot=tooltip-content]_&]:text-background dark:[[data-slot=tooltip-content]_&]:bg-background/10",
        className
      )}
      {...props}
    />
  )
}

function KbdGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <kbd
      data-slot="kbd-group"
      className={cn("inline-flex items-center gap-1", className)}
      {...props}
    />
  )
}

function KbdShortcut({
  shortcut,
  className,
}: {
  shortcut: string
  className?: string
}) {
  const parts = shortcut.includes(" ")
    ? shortcut.split(/\s+/)
    : Array.from(shortcut)

  return (
    <KbdGroup className={cn("gap-0.5", className)}>
      {parts.map((p, i) => (
        <Kbd
          key={i}
          className="h-5 min-w-5 rounded-md border border-border/60 bg-muted/70 px-1 text-[10px] font-medium tabular-nums text-muted-foreground/85"
        >
          {p}
        </Kbd>
      ))}
    </KbdGroup>
  )
}

export { Kbd, KbdGroup, KbdShortcut }
