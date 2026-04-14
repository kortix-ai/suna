'use client';

import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bug,
  RefreshCw,
  Shield,
  Sparkles,
  Zap,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ChangelogChange } from '@/lib/platform-client';

const changeTypeConfig: Record<string, { icon: typeof Sparkles; color: string }> = {
  feature: { icon: Sparkles, color: 'text-emerald-500' },
  fix: { icon: Bug, color: 'text-red-400' },
  improvement: { icon: Zap, color: 'text-blue-400' },
  breaking: { icon: AlertTriangle, color: 'text-amber-500' },
  upstream: { icon: RefreshCw, color: 'text-violet-400' },
  security: { icon: Shield, color: 'text-rose-400' },
  deprecation: { icon: AlertTriangle, color: 'text-orange-400' },
};

function ChangeItem({ change }: { change: ChangelogChange }) {
  const config = changeTypeConfig[change.type] ?? changeTypeConfig.improvement;
  const Icon = config.icon;

  return (
    <div className="flex items-start gap-2 py-0.5">
      <Icon className={cn('h-3.5 w-3.5 mt-0.5 flex-shrink-0', config.color)} />
      <span className="text-sm text-foreground/80">{change.text}</span>
    </div>
  );
}

export function UpdateChangelogPreview({
  changes,
  title,
  description,
  className,
  bodyClassName,
  variant = 'muted',
  collapsedCount = 4,
  moreButtonVariant = 'ghost',
}: {
  changes: ChangelogChange[];
  title?: string;
  description?: string;
  className?: string;
  bodyClassName?: string;
  variant?: 'muted' | 'subtle';
  collapsedCount?: number;
  moreButtonVariant?: 'ghost' | 'link';
}) {
  const [expanded, setExpanded] = useState(false);

  const visibleChanges = useMemo(
    () => (expanded ? changes : changes.slice(0, collapsedCount)),
    [changes, collapsedCount, expanded],
  );
  const remainingCount = Math.max(changes.length - collapsedCount, 0);
  const hasMore = !expanded && remainingCount > 0;

  if (changes.length === 0) return null;

  return (
    <div
      className={cn(
        'overflow-hidden',
        variant === 'muted'
          ? 'rounded-xl border border-border/60 bg-muted/10'
          : 'rounded-lg border border-border/50 bg-muted/30',
        className,
      )}
    >
      {(title || description) && (
        <div className={cn('border-b', variant === 'muted' ? 'border-border/60 bg-background/60 px-4 py-3' : 'border-border/30 px-3 py-2.5')}>
          {title ? <div className="text-sm font-medium">{title}</div> : null}
          {description ? <div className="text-xs text-muted-foreground mt-1">{description}</div> : null}
        </div>
      )}

      <div className={cn('max-h-72 overflow-y-auto space-y-0.5', variant === 'muted' ? 'px-4 py-3' : 'px-3 py-2.5', bodyClassName)}>
        {visibleChanges.map((change, index) => (
          <ChangeItem key={`${change.type}-${index}`} change={change} />
        ))}
      </div>

      {hasMore ? (
        <Button
          onClick={() => setExpanded(true)}
          variant={moreButtonVariant}
          size="sm"
          className={cn(
            'w-full rounded-none',
            variant === 'muted' ? 'border-t border-border/60' : 'border-t border-border/30 h-auto py-2',
          )}
        >
          Show {remainingCount} more changes
        </Button>
      ) : null}
    </div>
  );
}
