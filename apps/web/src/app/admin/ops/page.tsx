'use client';

import { Activity, AlertTriangle, Clock, Database, Gauge, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useOpsOverview } from '@/hooks/admin/use-ops-overview';
import {
  SectionContainer,
  SectionHeader,
  StatPill,
  StatRow,
} from '../_components/section-header';

export default function AdminOpsPage() {
  const { data, isLoading, refetch, isFetching } = useOpsOverview();

  if (isLoading || !data) {
    return (
      <SectionContainer>
        <SectionHeader icon={Activity} title="Operations" />
        <StatRow>
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-24 rounded-xl" />
          ))}
        </StatRow>
        <Skeleton className="h-80 rounded-xl" />
      </SectionContainer>
    );
  }

  return (
    <SectionContainer>
      <SectionHeader
        icon={Activity}
        title="Operations"
        description={`Last refreshed ${formatDate(data.generated_at)}`}
        actions={
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        }
      />

      <StatRow>
        <StatPill label="API" value={data.api.status.toUpperCase()} hint={data.api.env} tone="success" />
        <StatPill label="Queued work" value={data.queues.queued_total} tone={data.queues.queued_total > 0 ? 'warning' : 'success'} />
        <StatPill label="Errored sandboxes" value={data.sandboxes.errored} tone={data.sandboxes.errored > 0 ? 'danger' : 'success'} />
        <StatPill label="LLM calls 24h" value={data.usage.calls_24h} hint={`$${data.usage.cost_usd_24h.toFixed(4)}`} />
      </StatRow>

      <div className="grid gap-4 lg:grid-cols-4">
        <SignalPanel icon={Gauge} title="Sessions">
          <StatusList values={data.sessions.by_status} />
        </SignalPanel>
        <SignalPanel icon={Database} title="Sandboxes">
          <StatusList values={data.sandboxes.by_status} />
          <div className="mt-4 border-t border-border/60 pt-4">
            <StatusList values={data.sandboxes.by_provider} />
          </div>
        </SignalPanel>
        <SignalPanel icon={AlertTriangle} title="Queues">
          <StatusList values={data.queues.trigger_events_by_status} label="Triggers" />
          <div className="mt-4 border-t border-border/60 pt-4">
            <StatusList values={data.queues.channel_events_by_status} label="Channels" />
          </div>
        </SignalPanel>
        <SignalPanel icon={Activity} title="Observability">
          <BooleanStatus label="Managed logs" enabled={data.observability.managed_logs_configured} hint={data.observability.managed_log_host ?? undefined} />
          <BooleanStatus label="Error tracking" enabled={data.observability.error_tracking_configured} />
          <BooleanStatus label="Trace headers" enabled={data.observability.trace_headers_enabled} />
          <BooleanStatus label="OTLP exporter" enabled={data.observability.otlp_exporter_configured} warningWhenDisabled />
        </SignalPanel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SignalPanel icon={Clock} title="Usage by provider">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead className="text-right">Calls</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.usage.last_24h_by_provider.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground">No usage in the last 24h.</TableCell>
                </TableRow>
              ) : data.usage.last_24h_by_provider.map((row) => (
                <TableRow key={row.provider}>
                  <TableCell>{row.provider}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.calls}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.input_tokens + row.output_tokens}</TableCell>
                  <TableCell className="text-right tabular-nums">${row.cost_usd.toFixed(4)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </SignalPanel>

        <SignalPanel icon={Database} title="Migration">
          <StatusList values={data.migrations.by_status} />
          <div className="mt-4 flex items-center justify-between rounded-lg border border-border/60 px-3 py-2">
            <span className="text-sm text-muted-foreground">Legacy sandboxes</span>
            <Badge variant={data.migrations.active_legacy_sandboxes > 0 ? 'warning' : 'success'}>
              {data.migrations.active_legacy_sandboxes}
            </Badge>
          </div>
        </SignalPanel>
      </div>

      <SignalPanel icon={Activity} title="Recent audit events">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Resource</TableHead>
              <TableHead>Account</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.audit.recent.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-muted-foreground">No recent audit events.</TableCell>
              </TableRow>
            ) : data.audit.recent.map((event) => (
              <TableRow key={event.event_id}>
                <TableCell className="whitespace-nowrap text-muted-foreground">{formatDate(event.occurred_at)}</TableCell>
                <TableCell>{event.action}</TableCell>
                <TableCell>{event.resource_type}{event.resource_id ? `:${event.resource_id.slice(0, 8)}` : ''}</TableCell>
                <TableCell className="font-mono text-xs">{event.account_id?.slice(0, 8) ?? '-'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </SignalPanel>
    </SectionContainer>
  );
}

function SignalPanel({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border/60 bg-card p-4">
      <div className="mb-4 flex items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function StatusList({ values, label }: { values: Record<string, number>; label?: string }) {
  const entries = Object.entries(values);
  return (
    <div className="space-y-2">
      {label && <div className="text-xs font-medium uppercase text-muted-foreground">{label}</div>}
      {entries.length === 0 ? (
        <div className="text-sm text-muted-foreground">No data.</div>
      ) : entries.map(([key, value]) => (
        <div key={key} className="flex items-center justify-between gap-3">
          <span className="truncate text-sm capitalize">{key.replace(/_/g, ' ')}</span>
          <Badge variant={badgeVariant(key)}>{value}</Badge>
        </div>
      ))}
    </div>
  );
}

function BooleanStatus({
  label,
  enabled,
  hint,
  warningWhenDisabled,
}: {
  label: string;
  enabled: boolean;
  hint?: string;
  warningWhenDisabled?: boolean;
}) {
  return (
    <div className="mb-2 flex items-center justify-between gap-3 last:mb-0">
      <span className="min-w-0 truncate text-sm text-muted-foreground" title={hint ? `${label}: ${hint}` : label}>
        {label}
      </span>
      <Badge variant={enabled ? 'success' : warningWhenDisabled ? 'warning' : 'secondary'}>
        {enabled ? 'On' : 'Off'}
      </Badge>
    </div>
  );
}

function badgeVariant(key: string): React.ComponentProps<typeof Badge>['variant'] {
  if (/failed|error|offline/.test(key)) return 'destructive';
  if (/queued|provisioning|stopped/.test(key)) return 'warning';
  if (/active|running|verified|applied|fired/.test(key)) return 'success';
  return 'secondary';
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString();
}
