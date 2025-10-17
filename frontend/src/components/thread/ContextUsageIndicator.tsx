"use client"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { useContextUsageStore } from "@/lib/stores/context-usage-store"
import { useModelSelection } from "@/hooks/use-model-selection"
import { cn } from "@/lib/utils"

interface ContextUsageIndicatorProps {
  threadId: string
  modelName?: string
  radius?: number
  strokeWidth?: number
  className?: string
}

export const ContextUsageIndicator = ({
  threadId,
  modelName,
  radius: radiusProp = 28,
  strokeWidth: strokeWidthProp = 4,
  className,
}: ContextUsageIndicatorProps) => {
  const contextUsage = useContextUsageStore((state) => state.getUsage(threadId))
  const { allModels } = useModelSelection()

  if (!contextUsage || !contextUsage.current_tokens) return null

  const { current_tokens } = contextUsage

  const modelData = modelName ? allModels.find((m) => m.id === modelName) : null
  const context_window = modelData?.contextWindow || 200000

  const rawPct = (current_tokens / context_window) * 100
  const percentage = Math.max(0, Math.min(100, rawPct))

  const radius = radiusProp
  const strokeWidth = strokeWidthProp
  const circumference = 2 * Math.PI * radius
  const strokeDashoffset = circumference - (percentage / 100) * circumference

  const getNeutralStroke = (pct: number) => (pct < 75 ? "var(--color-muted-foreground)" : "var(--color-foreground)")
  const strokeColor = getNeutralStroke(percentage)

  const size = (radius + strokeWidth) * 2

  return (
    <div className={cn("absolute inset-0 pointer-events-none", className)}>
      <TooltipProvider>
        <Tooltip delayDuration={250}>
          <TooltipTrigger asChild>
            <svg
              className={cn("absolute inset-0 -rotate-90 w-full h-full pointer-events-auto")}
              viewBox={`0 0 ${size} ${size}`}
              role="img"
              aria-label={`Context usage ${percentage.toFixed(1)} percent`}
            >
              <title>Context usage</title>
              <desc>{`${current_tokens.toLocaleString()} of ${context_window.toLocaleString()} tokens used.`}</desc>

              {/* background circle stays neutral */}
              <circle
                cx={radius + strokeWidth}
                cy={radius + strokeWidth}
                r={radius}
                fill="none"
                stroke="currentColor"
                strokeWidth={strokeWidth}
                className="stroke-current opacity-50"
                style={{ stroke: "var(--color-border)" }}
              />

              {/* progress circle: neutral grayscale only */}
              <circle
                cx={radius + strokeWidth}
                cy={radius + strokeWidth}
                r={radius}
                fill="none"
                stroke="currentColor"
                strokeWidth={strokeWidth}
                strokeDasharray={circumference}
                strokeDashoffset={strokeDashoffset}
                strokeLinecap="round"
                className="stroke-current transition-[stroke-dashoffset,stroke] duration-300 ease-out"
                style={{ stroke: strokeColor }}
              />
            </svg>
          </TooltipTrigger>
          <TooltipContent
            side="top"
            align="center"
            className="w-auto max-w-[30rem] px-2 py-1.5 text-xs"
          >
            <div className="space-y-1">
              <p className="font-medium text-pretty">Context: {percentage.toFixed(1)}%</p>
              <p className="text-xs text-muted-foreground">
                {current_tokens.toLocaleString()} / {context_window.toLocaleString()} tokens
              </p>
              <p>{modelName ? ` • ${modelName}` : ""}</p>
              
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <span className="sr-only">
        Context usage {percentage.toFixed(1)} percent. {current_tokens.toLocaleString()} of{" "}
        {context_window.toLocaleString()} tokens used
        {modelName ? ` for model ${modelName}.` : "."}
      </span>
    </div>
  )
}
