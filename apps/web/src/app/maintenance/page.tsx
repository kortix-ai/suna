import { Wrench } from 'lucide-react';
import { getMaintenanceConfig } from '@/lib/maintenance-store';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function MaintenancePage() {
  const config = await getMaintenanceConfig();

  const title = config.title || 'We\'ll be right back';
  const message =
    config.message ||
    'We\'re performing scheduled maintenance to improve your experience. Please check back soon.';

  const hasSchedule = config.startTime && config.endTime;

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <div className="max-w-lg w-full text-center space-y-6">
        {/* Icon */}
        <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-2xl bg-amber-500/10 border border-amber-500/20">
          <Wrench className="h-10 w-10 text-amber-500" />
        </div>

        {/* Title */}
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {title}
          </h1>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-md mx-auto">
            {message}
          </p>
        </div>

        {/* Schedule */}
        {hasSchedule && (
          <div className="inline-flex items-center gap-2 rounded-lg bg-muted px-4 py-2.5 text-sm text-muted-foreground">
            <span className="font-medium">Scheduled:</span>
            <span>
              {formatDateTime(config.startTime!)} – {formatDateTime(config.endTime!)}
            </span>
          </div>
        )}

        {/* Status link */}
        {config.statusUrl && (
          <div>
            <a
              href={config.statusUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-primary hover:underline underline-offset-4"
            >
              Check system status →
            </a>
          </div>
        )}

        {/* Auto-refresh hint */}
        <p className="text-xs text-muted-foreground/60">
          This page refreshes automatically every 30 seconds.
        </p>

        {/* Auto-refresh meta (client-side) */}
        <AutoRefresh />
      </div>
    </div>
  );
}

function AutoRefresh() {
  return (
    <script
      dangerouslySetInnerHTML={{
        __html: `setTimeout(function(){location.reload()},30000)`,
      }}
    />
  );
}

function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
