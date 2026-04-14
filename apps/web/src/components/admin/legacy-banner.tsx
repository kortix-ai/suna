import { AlertTriangle } from 'lucide-react';

export function LegacyBanner({
  feature,
  message,
}: {
  feature: string;
  message?: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="min-w-0">
        <div className="font-medium text-foreground">
          {feature} is legacy — not wired to the current backend
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground leading-relaxed">
          {message ??
            'This page is UI from the old platform. Treat any data here as stale — it will be reimplemented against the current backend.'}
        </div>
      </div>
    </div>
  );
}
