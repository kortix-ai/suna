import { LocalTime } from '@/components/ui/local-time';
import { getHardcodedUiServerText } from '@/lib/hardcoded-ui-server';
import { getMaintenanceConfig } from '@/lib/maintenance-store';
import { WrenchIcon as Wrench } from '@/lib/icons/ssr';

const SCHEDULE_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
};

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function MaintenancePage() {
  const tHardcodedUi = { raw: getHardcodedUiServerText };
  const config = await getMaintenanceConfig();

  const title = config.title || "We'll be right back";
  const message =
    config.message ||
    "We're performing scheduled maintenance to improve your experience. Please check back soon.";

  const hasSchedule = config.startTime && config.endTime;

  return (
    <div className="bg-background flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-lg space-y-6 text-center">
        {/* Icon */}
        <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-2xl border border-amber-500/20 bg-amber-500/10">
          <Wrench className="h-10 w-10 text-amber-500" />
        </div>

        {/* Title */}
        <div className="space-y-2">
          <h1 className="text-foreground text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="text-muted-foreground mx-auto max-w-md text-sm leading-relaxed">
            {message}
          </p>
        </div>

        {/* Schedule */}
        {hasSchedule && (
          <div className="bg-muted text-muted-foreground inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm">
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
              className="text-primary text-sm font-medium underline-offset-4 hover:underline"
            >
              {tHardcodedUi.raw('appMaintenancePage.line54JsxTextCheckSystemStatus')}
            </a>
          </div>
        )}

        {/* Auto-refresh hint */}
        <p className="text-muted-foreground/60 text-xs">
          {tHardcodedUi.raw(
            'appMaintenancePage.line61JsxTextThisPageRefreshesAutomaticallyEvery30Seconds',
          )}
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
