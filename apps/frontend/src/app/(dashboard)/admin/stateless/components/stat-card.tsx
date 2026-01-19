"use client";

import { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ArrowUp, ArrowDown, Minus } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer } from "recharts";

interface StatCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon?: ReactNode;
  trend?: "up" | "down" | "neutral";
  trendValue?: string;
  trendLabel?: string;
  sparklineData?: number[];
  variant?: "default" | "success" | "warning" | "danger" | "info";
  size?: "default" | "compact";
  className?: string;
}

const variantStyles = {
  default: {
    icon: "text-muted-foreground",
    sparkline: "#71717a",
  },
  success: {
    icon: "text-emerald-500",
    sparkline: "#10b981",
  },
  warning: {
    icon: "text-amber-500",
    sparkline: "#f59e0b",
  },
  danger: {
    icon: "text-red-500",
    sparkline: "#ef4444",
  },
  info: {
    icon: "text-primary",
    sparkline: "#3b82f6",
  },
};

export function StatCard({
  title,
  value,
  subtitle,
  icon,
  trend,
  trendValue,
  trendLabel,
  sparklineData,
  variant = "default",
  size = "default",
  className,
}: StatCardProps) {
  const styles = variantStyles[variant];
  
  const chartData = sparklineData?.map((v, i) => ({ value: v, index: i })) || [];
  
  const TrendIcon = trend === "up" ? ArrowUp : trend === "down" ? ArrowDown : Minus;
  const trendColor = trend === "up" ? "text-emerald-500" : trend === "down" ? "text-red-500" : "text-muted-foreground";

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border bg-card transition-all duration-200 hover:border-border/80",
        size === "compact" ? "p-4" : "p-5",
        className
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-muted-foreground truncate">{title}</p>
          <p className={cn(
            "font-bold tracking-tight mt-1",
            size === "compact" ? "text-2xl" : "text-3xl"
          )}>
            {value}
          </p>
          {subtitle && (
            <p className="text-xs text-muted-foreground mt-1.5">{subtitle}</p>
          )}
          {(trend || trendValue) && (
            <div className="flex items-center gap-1.5 mt-2">
              {trend && <TrendIcon className={cn("w-3.5 h-3.5", trendColor)} />}
              {trendValue && (
                <span className={cn("text-xs font-medium", trendColor)}>{trendValue}</span>
              )}
              {trendLabel && (
                <span className="text-xs text-muted-foreground">{trendLabel}</span>
              )}
            </div>
          )}
        </div>
        
        <div className="flex flex-col items-end gap-2">
          {icon && (
            <div className={cn(
              "flex items-center justify-center",
              size === "compact" ? "w-10 h-10" : "w-12 h-12",
              styles.icon
            )}>
              {icon}
            </div>
          )}
          
          {sparklineData && sparklineData.length > 1 && (
            <div className={cn(
              "w-20",
              size === "compact" ? "h-8" : "h-10"
            )}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id={`gradient-${title.replace(/\s/g, "")}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={styles.sparkline} stopOpacity={0.3} />
                      <stop offset="100%" stopColor={styles.sparkline} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <Area
                    type="monotone"
                    dataKey="value"
                    stroke={styles.sparkline}
                    strokeWidth={1.5}
                    fill={`url(#gradient-${title.replace(/\s/g, "")})`}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface StatCardGridProps {
  children: ReactNode;
  columns?: 2 | 3 | 4;
  className?: string;
}

export function StatCardGrid({ children, columns = 4, className }: StatCardGridProps) {
  return (
    <div className={cn(
      "grid gap-4",
      columns === 2 && "grid-cols-1 sm:grid-cols-2",
      columns === 3 && "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
      columns === 4 && "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4",
      className
    )}>
      {children}
    </div>
  );
}
