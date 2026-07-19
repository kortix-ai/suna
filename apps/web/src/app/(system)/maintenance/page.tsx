import { getHardcodedUiServerText } from '@/lib/hardcoded-ui-server';
import { Wrench } from 'lucide-react';
import { redirect } from 'next/navigation';
import { getMaintenanceConfig } from '@/lib/maintenance-store';
import { LocalTime } from '@/components/ui/local-time';

const SCHEDULE_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
};

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Only allow same-origin relative paths as a redirect target. Blocks
// protocol-relative (`//evil.com`) and backslash tricks so the `from` param
// can't be turned into an open redirect.
function safeInternalPath(from?: string): string {
  if (!from || !from.startsWith('/') || from.startsWith('//') || from.startsWith('/\\')) {
    return '/';
  }
  return from;
}

export default async function MaintenancePage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const tHardcodedUi = { raw: getHardcodedUiServerText };
  const config = await getMaintenanceConfig();

  // Maintenance is over (or was never blocking): send the user back to where
  // they came from — or home. The page auto-reloads every 30s, so an active
  // "We'll be right back" visitor gets bounced out on the first reload after a
  // full lockdown is lifted, instead of being stranded here forever.
  if (config.level !== 'blocking') {
    const { from } = await searchParams;
    redirect(safeInternalPath(from));
  }

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
              <LocalTime
                value={config.startTime!}
                options={SCHEDULE_FORMAT}
                fallback={config.startTime!}
              />{' '}
              –{' '}
              <LocalTime
                value={config.endTime!}
                options={SCHEDULE_FORMAT}
                fallback={config.endTime!}
              />
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
            >{tHardcodedUi.raw('appMaintenancePage.line54JsxTextCheckSystemStatus')}</a>
          </div>
        )}

        {/* Auto-refresh hint */}
        <p className="text-xs text-muted-foreground/60">{tHardcodedUi.raw('appMaintenancePage.line61JsxTextThisPageRefreshesAutomaticallyEvery30Seconds')}</p>

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
