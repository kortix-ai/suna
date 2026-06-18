import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export type HintProps = {
  label?: React.ReactNode;
  children?: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  alignOffset?: number;
  className?: string;
  content?: React.ReactNode;
} & React.ComponentProps<typeof Tooltip>;

const Hint = ({
  label,
  children,
  className,
  side = "right",
  align = "center",
  sideOffset = 10,
  alignOffset = 10,
  content,
  ...props
}: HintProps) => {
  return (
    <Tooltip {...props}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        className={className}
      >
        {label ? label : content}
      </TooltipContent>
    </Tooltip>
  );
};

export default Hint;
