'use client';

import { cn } from '@/lib/utils';

interface MetricCardProps {
  label: string;
  value: string | number;
  subtext?: string;
  trend?: {
    value: number;
    isPositive: boolean;
  };
  size?: 'sm' | 'md' | 'lg';
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'muted';
  className?: string;
}

export function MetricCard({
  label,
  value,
  subtext,
  trend,
  size = 'md',
  variant = 'default',
  className,
}: MetricCardProps) {
  const valueStyles = {
    sm: 'text-xl font-semibold',
    md: 'text-3xl font-bold tracking-tight',
    lg: 'text-5xl font-bold tracking-tight',
  };

  const variantStyles = {
    default: 'text-foreground',
    success: 'text-emerald-600 dark:text-emerald-400',
    warning: 'text-amber-600 dark:text-amber-400',
    danger: 'text-red-600 dark:text-red-400',
    muted: 'text-muted-foreground',
  };

  return (
    <div className={cn('space-y-1', className)}>
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
        {label}
      </p>
      <p className={cn(valueStyles[size], variantStyles[variant])}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </p>
      {(subtext || trend) && (
        <div className="flex items-center gap-2">
          {subtext && (
            <span className="text-xs text-muted-foreground">{subtext}</span>
          )}
          {trend && (
            <span
              className={cn(
                'text-xs font-medium',
                trend.isPositive ? 'text-emerald-600' : 'text-red-500'
              )}
            >
              {trend.isPositive ? '+' : ''}{trend.value}%
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// Simplified StatCard for backwards compatibility
interface StatCardProps {
  title: string;
  value: string | number;
  description?: string;
  icon?: React.ReactNode;
  trend?: {
    value: number;
    isPositive: boolean;
  };
  className?: string;
}

export function StatCard({ title, value, description, icon, trend, className }: StatCardProps) {
  return (
    <div className={cn(
      'relative overflow-hidden rounded-xl border bg-card p-5',
      'transition-all duration-200 hover:shadow-md hover:border-border/80',
      className
    )}>
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
            {title}
          </p>
          <p className="text-2xl font-bold tracking-tight">
            {typeof value === 'number' ? value.toLocaleString() : value}
          </p>
          {description && (
            <p className="text-xs text-muted-foreground">{description}</p>
          )}
          {trend && (
            <p className={cn(
              'text-xs font-medium',
              trend.isPositive ? 'text-emerald-600' : 'text-red-500'
            )}>
              {trend.isPositive ? '+' : ''}{trend.value}%
            </p>
          )}
        </div>
        {icon && (
          <div className="rounded-lg bg-muted/50 p-2.5 text-muted-foreground">
            {icon}
          </div>
        )}
      </div>
    </div>
  );
}
