'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { kortix } from '@/lib/kortix';
import { qk } from '@/lib/query-keys';
import { cn, relativeTime } from '@/lib/utils';
import type {
  GatewayBudgetRow,
  GatewayKeyRow,
  GatewayLogRow,
  GatewaySessionStat,
} from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  Ban,
  Copy,
  KeyRound,
  Layers,
  Loader2,
  MessagesSquare,
  Plus,
  ScrollText,
  Trash2,
  TriangleAlert,
  Wallet,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const compact = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});
const count = new Intl.NumberFormat('en-US');

const LOG_LIMIT = 20;

export function ProjectUsage({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [windowValue, setWindowValue] = useState('7');
  const days = Number(windowValue);
  const gateway = kortix.project(projectId).gateway;

  const overview = useQuery({
    queryKey: ['gateway', projectId, 'overview', days],
    queryFn: () => gateway.overview(days),
  });
  const series = useQuery({
    queryKey: ['gateway', projectId, 'series', days],
    queryFn: () => gateway.series(days),
  });
  const breakdown = useQuery({
    queryKey: ['gateway', projectId, 'breakdown', days],
    queryFn: () => gateway.breakdown(days),
  });
  const sessions = useQuery({
    queryKey: ['gateway', projectId, 'sessions', days],
    queryFn: () => gateway.sessions(days),
  });
  const errors = useQuery({
    queryKey: ['gateway', projectId, 'errors', days],
    queryFn: () => gateway.errors(days),
  });
  const logs = useQuery({
    queryKey: ['gateway', projectId, 'logs'],
    queryFn: () => gateway.logs({ limit: LOG_LIMIT }),
  });
  const budgets = useQuery({
    queryKey: ['gateway', projectId, 'budgets'],
    queryFn: () => gateway.budgets(),
  });
  const keys = useQuery({
    queryKey: ['gateway', projectId, 'keys'],
    queryFn: () => gateway.keys(),
  });
  // Gateway session stats carry only ids; resolve them to the human names the
  // rest of the app shows.
  const projectSessions = useQuery({
    queryKey: qk.sessions(projectId),
    queryFn: () => kortix.project(projectId).sessions.list(),
  });
  const sessionName = (id: string | null): string | null => {
    if (!id) return null;
    const row = projectSessions.data?.find((s) => s.session_id === id);
    return row?.name || row?.custom_name || null;
  };

  const [budgetLimit, setBudgetLimit] = useState('');
  const setBudget = useMutation({
    mutationFn: (limit: number) =>
      gateway.setBudget({ scope: 'project', limit_usd: limit, period: 'month' }),
    onSuccess: () => {
      setBudgetLimit('');
      qc.invalidateQueries({ queryKey: ['gateway', projectId, 'budgets'] });
      toast.success('Budget saved');
    },
    onError: () => toast.error('Could not save budget'),
  });
  const deleteBudget = useMutation({
    mutationFn: (budgetId: string) => gateway.deleteBudget(budgetId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['gateway', projectId, 'budgets'] });
      toast.success('Budget removed');
    },
    onError: () => toast.error('Could not remove budget'),
  });

  const [keyDialogOpen, setKeyDialogOpen] = useState(false);
  const [keyName, setKeyName] = useState('');
  const createKey = useMutation({
    mutationFn: (name: string) => gateway.createKey(name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['gateway', projectId, 'keys'] });
    },
    onError: () => toast.error('Could not create key'),
  });
  const revokeKey = useMutation({
    mutationFn: (keyId: string) => gateway.revokeKey(keyId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['gateway', projectId, 'keys'] });
      toast.success('Key revoked');
    },
    onError: () => toast.error('Could not revoke key'),
  });

  // Overview carries no latency field; derive a request-weighted average of
  // the daily p50 values from the series instead.
  const seriesPoints = series.data?.series ?? [];
  const weightedLatency = seriesPoints.reduce((sum, p) => sum + p.p50 * p.requests, 0);
  const latencyRequests = seriesPoints.reduce((sum, p) => sum + p.requests, 0);
  const avgLatency = latencyRequests > 0 ? Math.round(weightedLatency / latencyRequests) : null;

  const o = overview.data;
  const totalTokens = o ? o.input_tokens + o.output_tokens : null;
  const models = [...(breakdown.data?.models ?? [])].sort((a, b) => b.cost - a.cost);
  const sessionRows = sessions.data?.sessions ?? [];
  const errorRows = errors.data?.errors ?? [];
  const logRows = (logs.data?.logs ?? []).slice(0, LOG_LIMIT);
  const budgetRows = budgets.data?.budgets ?? [];
  const keyRows = keys.data?.keys ?? [];

  const memberSpend = (budget: GatewayBudgetRow): number | null => {
    if (!budgets.data) return null;
    if (budget.scope === 'project') return budgets.data.project_spend.cost;
    const member = budgets.data.members.find((m) => m.user_id === budget.subject_user_id);
    return member ? member.cost : null;
  };

  const closeKeyDialog = (open: boolean) => {
    setKeyDialogOpen(open);
    if (!open) {
      createKey.reset();
      setKeyName('');
    }
  };

  const copySecret = async (secret: string) => {
    try {
      await navigator.clipboard.writeText(secret);
      toast.success('Key copied');
    } catch {
      toast.error('Could not copy key');
    }
  };

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 px-6 py-8">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Usage</h1>
        <Select value={windowValue} onValueChange={setWindowValue}>
          <SelectTrigger size="sm" aria-label="Usage window">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7">7 days</SelectItem>
            <SelectItem value="30">30 days</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card className="grid grid-cols-2 divide-x divide-border p-0 text-center sm:grid-cols-4">
        {overview.isLoading ? (
          <>
            {['Requests', 'Total cost', 'Tokens', 'Avg latency'].map((label) => (
              <div key={label} className="px-4 py-4">
                <Skeleton className="mx-auto h-6 w-16" />
                <div className="mt-1 text-xs text-muted-foreground">{label}</div>
              </div>
            ))}
          </>
        ) : overview.isError ? (
          <div className="col-span-2 px-4 py-6 text-sm text-destructive sm:col-span-4">
            Could not load usage.
          </div>
        ) : (
          <>
            <Stat label="Requests" value={o ? count.format(o.requests) : '—'} />
            <Stat label="Total cost" value={o ? usd.format(o.total_cost) : '—'} />
            <Stat label="Tokens" value={totalTokens != null ? compact.format(totalTokens) : '—'} />
            <Stat
              label="Avg latency"
              value={avgLatency != null ? `${count.format(avgLatency)} ms` : '—'}
            />
          </>
        )}
      </Card>

      <Card className="overflow-hidden p-0">
        <SectionHeader icon={Layers} title="By model" />
        {breakdown.isLoading && <LoadingRow />}
        {breakdown.isError && <ErrorRow text="Could not load model breakdown." />}
        {breakdown.isSuccess && models.length === 0 && (
          <EmptyRow text="No requests in this window." />
        )}
        <div className="divide-y divide-border">
          {models.map((m) => (
            <div
              key={`${m.provider}/${m.model}`}
              className="flex items-center justify-between gap-3 px-5 py-2.5"
            >
              <div className="min-w-0">
                <div className="truncate font-mono text-xs">{m.model}</div>
                <div className="text-[10px] text-muted-foreground">{m.provider}</div>
              </div>
              <div className="flex shrink-0 items-center gap-4 text-xs tabular-nums">
                <span className="text-muted-foreground">{count.format(m.requests)} req</span>
                <span className="text-muted-foreground">{compact.format(m.tokens)} tok</span>
                <span className="w-20 text-right font-medium">{usd.format(m.cost)}</span>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <SectionHeader icon={MessagesSquare} title="Sessions" />
        {sessions.isLoading && <LoadingRow />}
        {sessions.isError && <ErrorRow text="Could not load sessions." />}
        {sessions.isSuccess && sessionRows.length === 0 && (
          <EmptyRow text="No session activity in this window." />
        )}
        <div className="max-h-80 divide-y divide-border overflow-y-auto scrollbar-thin">
          {sessionRows.map((s) => (
            <SessionUsageRow
              key={s.session_id ?? 'unattributed'}
              projectId={projectId}
              stat={s}
              name={sessionName(s.session_id)}
            />
          ))}
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <SectionHeader icon={ScrollText} title="Recent requests" />
        {logs.isLoading && <LoadingRow />}
        {logs.isError && <ErrorRow text="Could not load request logs." />}
        {logs.isSuccess && logRows.length === 0 && <EmptyRow text="No requests yet." />}
        <div className="max-h-80 divide-y divide-border overflow-y-auto scrollbar-thin">
          {logRows.map((log) => (
            <LogRow key={log.log_id} log={log} />
          ))}
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <SectionHeader icon={Wallet} title="Budgets">
          {budgets.data && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {usd.format(budgets.data.project_spend.cost)} spent
            </span>
          )}
        </SectionHeader>
        {budgets.isLoading && <LoadingRow />}
        {budgets.isError && <ErrorRow text="Could not load budgets." />}
        {budgets.isSuccess && budgetRows.length === 0 && <EmptyRow text="No budgets set." />}
        <div className="divide-y divide-border">
          {budgetRows.map((b) => (
            <BudgetRow
              key={b.budget_id}
              budget={b}
              spend={memberSpend(b)}
              removing={deleteBudget.isPending}
              onDelete={() => deleteBudget.mutate(b.budget_id)}
            />
          ))}
        </div>
        <form
          className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            const limit = Number(budgetLimit);
            if (Number.isFinite(limit) && limit > 0) setBudget.mutate(limit);
          }}
        >
          <Label htmlFor="budget-limit" className="text-xs text-muted-foreground">
            Monthly limit
          </Label>
          <Input
            id="budget-limit"
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            value={budgetLimit}
            onChange={(e) => setBudgetLimit(e.target.value)}
            placeholder="USD"
            className="h-8 w-32 tabular-nums"
          />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={!(Number(budgetLimit) > 0) || setBudget.isPending}
          >
            {setBudget.isPending && <Loader2 className="size-4 animate-spin" />}
            Set budget
          </Button>
        </form>
      </Card>

      <Card className="overflow-hidden p-0">
        <SectionHeader icon={KeyRound} title="Gateway keys">
          <Dialog open={keyDialogOpen} onOpenChange={closeKeyDialog}>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline">
                <Plus className="size-4" />
                Create key
              </Button>
            </DialogTrigger>
            <DialogContent>
              {createKey.data ? (
                <>
                  <DialogHeader>
                    <DialogTitle>Key created</DialogTitle>
                    <DialogDescription>
                      Copy this key now. It will not be shown again.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 select-all rounded-md bg-secondary px-3 py-2 font-mono text-xs break-all">
                      {createKey.data.secret_key}
                    </code>
                    <Button
                      variant="outline"
                      size="icon"
                      className="size-8 shrink-0"
                      aria-label="Copy key"
                      onClick={() => copySecret(createKey.data.secret_key)}
                    >
                      <Copy className="size-4" />
                    </Button>
                  </div>
                  <DialogFooter>
                    <Button onClick={() => closeKeyDialog(false)}>Done</Button>
                  </DialogFooter>
                </>
              ) : (
                <form
                  className="space-y-4"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (keyName.trim()) createKey.mutate(keyName.trim());
                  }}
                >
                  <DialogHeader>
                    <DialogTitle>Create gateway key</DialogTitle>
                    <DialogDescription>
                      A key for calling the LLM gateway from your own code.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-2">
                    <Label htmlFor="gateway-key-name">Name</Label>
                    <Input
                      id="gateway-key-name"
                      value={keyName}
                      onChange={(e) => setKeyName(e.target.value)}
                      placeholder="production"
                    />
                  </div>
                  <DialogFooter>
                    <Button type="submit" disabled={!keyName.trim() || createKey.isPending}>
                      {createKey.isPending && <Loader2 className="size-4 animate-spin" />}
                      Create
                    </Button>
                  </DialogFooter>
                </form>
              )}
            </DialogContent>
          </Dialog>
        </SectionHeader>
        {keys.isLoading && <LoadingRow />}
        {keys.isError && <ErrorRow text="Could not load keys." />}
        {keys.isSuccess && keyRows.length === 0 && <EmptyRow text="No gateway keys yet." />}
        <div className="divide-y divide-border">
          {keyRows.map((k) => (
            <KeyRow
              key={k.key_id}
              apiKey={k}
              revoking={revokeKey.isPending}
              onRevoke={() => revokeKey.mutate(k.key_id)}
            />
          ))}
        </div>
      </Card>

      {(errors.isError || (errors.isSuccess && errorRows.length > 0)) && (
        <Card className="overflow-hidden border-destructive/30 p-0">
          <SectionHeader icon={TriangleAlert} title="Errors" />
          {errors.isError && <ErrorRow text="Could not load error stats." />}
          <div className="divide-y divide-border">
            {errorRows.map((e) => (
              <div key={e.code} className="flex items-center justify-between gap-3 px-5 py-2.5">
                <span className="min-w-0 truncate font-mono text-xs">{e.code}</span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {count.format(e.count)}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="px-4 py-4">
      <div className="truncate text-lg font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function SectionHeader({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Icon className="size-4 text-muted-foreground" />
        {title}
      </div>
      {children}
    </div>
  );
}

function LoadingRow() {
  return (
    <div className="p-4">
      <Skeleton className="h-5 w-44" />
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return <div className="p-6 text-center text-sm text-muted-foreground">{text}</div>;
}

function ErrorRow({ text }: { text: string }) {
  return <div className="p-6 text-center text-sm text-destructive">{text}</div>;
}

function SessionUsageRow({
  projectId,
  stat,
  name,
}: {
  projectId: string;
  stat: GatewaySessionStat;
  name: string | null;
}) {
  const rowClass = 'flex items-center justify-between gap-3 px-5 py-2.5';
  const inner = (
    <>
      {name ? (
        <span className="min-w-0 truncate text-xs">{name}</span>
      ) : (
        <span className="min-w-0 truncate font-mono text-xs">
          {stat.session_id || 'unattributed'}
        </span>
      )}
      <div className="flex shrink-0 items-center gap-4 text-xs tabular-nums">
        <span className="text-muted-foreground">{count.format(stat.requests)} req</span>
        <span className="w-20 text-right font-medium">{usd.format(stat.total_cost)}</span>
      </div>
    </>
  );
  return stat.session_id ? (
    <Link
      href={`/projects/${projectId}/sessions/${stat.session_id}`}
      className={cn(rowClass, 'transition-colors hover:bg-secondary/50')}
    >
      {inner}
    </Link>
  ) : (
    <div className={rowClass}>{inner}</div>
  );
}

function LogRow({ log }: { log: GatewayLogRow }) {
  return (
    <div className="flex items-center justify-between gap-3 px-5 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <Badge
          variant={log.ok ? 'outline' : 'destructive'}
          className="text-[10px] tabular-nums"
        >
          {log.status}
        </Badge>
        <span className="truncate font-mono text-xs">
          {log.resolved_model || log.requested_model}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground tabular-nums">
        <span>{compact.format(log.input_tokens + log.output_tokens)} tok</span>
        <span>{usd.format(log.final_cost)}</span>
        <span>{count.format(log.latency_ms)} ms</span>
        <span>{relativeTime(log.created_at)}</span>
      </div>
    </div>
  );
}

function BudgetRow({
  budget,
  spend,
  removing,
  onDelete,
}: {
  budget: GatewayBudgetRow;
  spend: number | null;
  removing: boolean;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-5 py-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-sm font-medium tabular-nums">{usd.format(budget.limit_usd)}</span>
        <Badge variant="secondary" className="text-[10px] capitalize">
          {budget.period}
        </Badge>
        <Badge variant="outline" className="text-[10px] capitalize">
          {budget.scope}
        </Badge>
        {budget.action === 'warn' && (
          <Badge variant="outline" className="text-[10px]">
            warn
          </Badge>
        )}
        {spend != null && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {usd.format(spend)} spent
          </span>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
        disabled={removing}
        onClick={onDelete}
        aria-label={`Delete ${budget.period} ${budget.scope} budget`}
      >
        <Trash2 className="size-4" />
      </Button>
    </div>
  );
}

function KeyRow({
  apiKey,
  revoking,
  onRevoke,
}: {
  apiKey: GatewayKeyRow;
  revoking: boolean;
  onRevoke: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-5 py-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{apiKey.name}</span>
          {apiKey.status !== 'active' && (
            <Badge variant="outline" className="text-[10px] capitalize">
              {apiKey.status}
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 text-[10px] text-muted-foreground">
          {apiKey.key_prefix && <span className="font-mono">{apiKey.key_prefix}…</span>}
          <span>created {relativeTime(apiKey.created_at)}</span>
          <span>
            {apiKey.last_used_at ? `used ${relativeTime(apiKey.last_used_at)}` : 'never used'}
          </span>
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
        disabled={revoking || apiKey.status !== 'active'}
        onClick={onRevoke}
        aria-label={`Revoke ${apiKey.name}`}
      >
        <Ban className="size-4" />
      </Button>
    </div>
  );
}
