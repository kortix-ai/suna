"use client"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { useContextUsageStore } from "@/stores/context-usage-store"
import { useModelSelection } from "@/hooks/agents"
import { cn } from "@/lib/utils"

interface ContextUsageIndicatorProps {
  threadId: string
  modelName?: string
  className?: string
}

export const ContextUsageIndicator = ({
  threadId,
  modelName,
  className,
}: ContextUsageIndicatorProps) => {
  const contextUsage = useContextUsageStore((state) => state.getUsage(threadId))
  const summarizing = useContextUsageStore((state) => state.isSummarizing(threadId))
  const { allModels } = useModelSelection()

  if (!summarizing && (!contextUsage || !contextUsage.current_tokens)) return null

  const current_tokens = contextUsage?.current_tokens || 0

  const modelData = modelName ? allModels.find((m) => m.id === modelName) : null
  const context_window = modelData?.contextWindow || 200000
  const displayModelName = modelData?.label || ""

  const rawPct = (current_tokens / context_window) * 100
  const percentage = Math.max(0, Math.min(100, rawPct))

  const getColor = (pct: number) => {
    if (pct < 60) return "text-muted-foreground"
    if (pct < 75) return "text-muted-foreground"
    if (pct < 90) return "text-amber-500/80 dark:text-amber-400/80"
    return "text-red-400/90 dark:text-red-400/80"
  }

  const getStrokeClass = (pct: number) => {
    if (pct < 75) return "stroke-muted-foreground/60"
    if (pct < 90) return "stroke-amber-500/70 dark:stroke-amber-400/70"
    return "stroke-red-400/80 dark:stroke-red-400/70"
  }

  const colorClass = getColor(percentage)
  const strokeClass = summarizing
    ? "stroke-muted-foreground/70"
    : getStrokeClass(percentage)

  const radius = 7
  const strokeWidth = 1.5
  const circumference = 2 * Math.PI * radius
  const strokeDashoffset = circumference - (percentage / 100) * circumference
  const size = (radius + strokeWidth) * 2

  return (
    <TooltipProvider>
      <Tooltip delayDuration={200}>
        <TooltipTrigger asChild>
          <div className={cn(
            "flex items-center gap-1.5 cursor-help transition-opacity duration-300 hover:opacity-100",
            summarizing ? "opacity-90" : percentage < 75 ? "opacity-50 hover:opacity-80" : "opacity-100",
            className
          )}>
            <div className="relative">
              <svg
                className={cn("w-5 h-5 -rotate-90")}
                viewBox={`0 0 ${size} ${size}`}
                role="img"
                aria-label={summarizing ? "Summarizing context" : `Context usage ${percentage.toFixed(1)} percent`}
              >
                {/* Background track */}
                <circle
                  cx={radius + strokeWidth}
                  cy={radius + strokeWidth}
                  r={radius}
                  fill="none"
                  strokeWidth={strokeWidth}
                  className="stroke-muted-foreground/15"
                />
                {/* Progress arc */}
                {!summarizing && (
                  <circle
                    cx={radius + strokeWidth}
                    cy={radius + strokeWidth}
                    r={radius}
                    fill="none"
                    strokeWidth={strokeWidth}
                    strokeDasharray={circumference}
                    strokeDashoffset={strokeDashoffset}
                    strokeLinecap="round"
                    className={cn(
                      "transition-all duration-700 ease-out",
                      strokeClass
                    )}
                  />
                )}
                {/* Summarizing arc — CSS animated */}
                {summarizing && (
                  <circle
                    cx={radius + strokeWidth}
                    cy={radius + strokeWidth}
                    r={radius}
                    fill="none"
                    strokeWidth={strokeWidth}
                    strokeDasharray={`${circumference * 0.3} ${circumference * 0.7}`}
                    strokeLinecap="round"
                    className="stroke-muted-foreground/60 animate-[spin_2s_linear_infinite] origin-center"
                    style={{ transformOrigin: `${radius + strokeWidth}px ${radius + strokeWidth}px` }}
                  />
                )}
              </svg>
            </div>
            {summarizing && (
              <span className="text-[11px] text-muted-foreground font-medium animate-pulse">
                Compressing...
              </span>
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          align="center"
          className="px-3 py-2 text-xs"
        >
          <div className="flex flex-col gap-1">
            {summarizing ? (
              <span className="text-muted-foreground text-[11px]">
                Compressing context window
              </span>
            ) : (
              <>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Context</span>
                  <span className={cn("font-mono tabular-nums", colorClass)}>
                    {percentage.toFixed(0)}%
                  </span>
                </div>
                <div className="text-muted-foreground/60 font-mono text-[10px] tabular-nums">
                  {(current_tokens / 1000).toFixed(0)}k / {(context_window / 1000).toFixed(0)}k tokens
                </div>
              </>
            )}
            {displayModelName && (
              <div className="text-muted-foreground/50 text-[10px] mt-0.5 border-t border-border/40 pt-1">
                {displayModelName}
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
