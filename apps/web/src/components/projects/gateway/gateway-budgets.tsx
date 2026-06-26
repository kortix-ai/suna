'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { InfoBanner } from '@/components/ui/info-banner';
import { UserAvatar } from '@/components/ui/user-avatar';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import {
  useDeleteGatewayBudget,
  useGatewayBudgets,
  useSetGatewayBudget,
} from '@/hooks/projects/use-project-gateway';
import type {
  GatewayBudgetRow,
  GatewayMemberSpend,
} from '@/lib/projects-gateway-client';

const PERIODS: { value: 'day' | 'week' | 'month'; label: string }[] = [
  { value: 'day', label: 'Daily' },
  { value: 'week', label: 'Weekly' },
  { value: 'month', label: 'Monthly' },
];
const ACTIONS: { value: 'block' | 'warn'; label: string }[] = [
  { value: 'block', label: 'Block' },
  { value: 'warn', label: 'Warn only' },
];

function fmtUsd(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

// Calm by default, red only when over the cap. The 80% "approaching" warning
// is carried by the InfoBanner, not by painting the bar amber.
function meterTone(pct: number): string {
  return pct >= 100 ? 'bg-destructive' : 'bg-kortix-blue';
}

function meterTextTone(pct: number): string {
  return pct >= 100 ? 'text-destructive' : 'text-foreground';
}

function Meter({ spent, limit, className }: { spent: number; limit: number; className?: string }) {
  const pct = limit > 0 ? (spent / limit) * 100 : 0;
  return (
    <div className={cn('h-2 overflow-hidden rounded-full bg-primary/[0.06]', className)}>
      <div
        className={cn('h-full rounded-full transition-[width] duration-700 ease-out', meterTone(pct))}
        style={{ width: `${Math.min(100, pct)}%` }}
      />
    </div>
  );
}

type EditTarget =
  | { scope: 'project' }
  | { scope: 'member'; subjectUserId: string; email: string | null };

export function GatewayBudgets({ projectId }: { projectId: string }) {
  const { data } = useGatewayBudgets(projectId);
  const setBudget = useSetGatewayBudget(projectId);
  const delBudget = useDeleteGatewayBudget(projectId);
  const [editing, setEditing] = useState<EditTarget | null>(null);

  const budgets = data?.budgets ?? [];
  const members = data?.members ?? [];
  const projectSpend = data?.project_spend?.cost ?? 0;
  const projectBudget = budgets.find((b) => b.scope === 'project') ?? null;
  const memberBudget = (uid: string | null): GatewayBudgetRow | null =>
    budgets.find((b) => b.scope === 'member' && b.subject_user_id === uid) ?? null;

  const remove = (budgetId: string) =>
    delBudget.mutate(budgetId, {
      onSuccess: () => toast.success('Budget removed'),
      onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not remove budget'),
    });

  const alerts: { label: string; pct: number }[] = [];
  if (projectBudget && projectBudget.limit_usd > 0 && projectSpend / projectBudget.limit_usd >= 0.8) {
    alerts.push({ label: 'Project', pct: (projectSpend / projectBudget.limit_usd) * 100 });
  }
  for (const m of members) {
    const b = memberBudget(m.user_id);
    if (b && b.limit_usd > 0 && m.cost / b.limit_usd >= 0.8) {
      alerts.push({ label: m.email ?? 'A member', pct: (m.cost / b.limit_usd) * 100 });
    }
  }
  alerts.sort((a, b) => b.pct - a.pct);
  const exceeded = alerts.some((a) => a.pct >= 100);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl space-y-4 p-5">
        {alerts.length > 0 && (
          <InfoBanner
            tone={exceeded ? 'destructive' : 'warning'}
            title={exceeded ? 'Budget exceeded' : 'Approaching budget'}
          >
            {alerts.map((a) => (
              <div key={a.label} className="tabular-nums">
                {a.label} — {a.pct >= 100 ? 'over limit' : `${Math.round(a.pct)}% used`}
              </div>
            ))}
          </InfoBanner>
        )}
        <SectionCard
          title="Project budget"
          description="Cap total spend across everyone in this project's gateway"
          action={
            <Button size="sm" variant="outline" onClick={() => setEditing({ scope: 'project' })}>
              {projectBudget ? 'Edit' : 'Set budget'}
            </Button>
          }
        >
          {projectBudget ? (
            (() => {
              const pct = projectBudget.limit_usd > 0 ? (projectSpend / projectBudget.limit_usd) * 100 : 0;
              const remaining = Math.max(0, projectBudget.limit_usd - projectSpend);
              return (
                <div className="space-y-3">
                  <div className="flex items-end justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-baseline gap-1.5">
                        <span className="text-2xl font-semibold tabular-nums text-foreground">
                          {fmtUsd(projectSpend)}
                        </span>
                        <span className="text-sm text-muted-foreground">
                          of {fmtUsd(projectBudget.limit_usd)} / {projectBudget.period}
                        </span>
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {fmtUsd(remaining)} remaining ·{' '}
                        {projectBudget.action === 'block' ? 'blocks at limit' : 'warns only'}
                      </div>
                    </div>
                    <span className={cn('text-2xl font-semibold tabular-nums', meterTextTone(pct))}>
                      {pct.toFixed(0)}%
                    </span>
                  </div>
                  <Meter spent={projectSpend} limit={projectBudget.limit_usd} />
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => remove(projectBudget.budget_id)}
                      className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                    >
                      Remove budget
                    </button>
                  </div>
                </div>
              );
            })()
          ) : (
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-2xl font-semibold tabular-nums text-foreground">{fmtUsd(projectSpend)}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">spent this month · no cap set</div>
              </div>
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Members"
          count={members.length}
          description="Spend per member this month — set a cap on anyone"
        >
          {members.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No member activity yet.</p>
          ) : (
            <div className="space-y-4">
              {members.map((m) => (
                <MemberRow
                  key={m.user_id ?? 'unknown'}
                  member={m}
                  maxCost={Math.max(1e-9, ...members.map((x) => x.cost))}
                  budget={memberBudget(m.user_id)}
                  onSetCap={() =>
                    m.user_id &&
                    setEditing({ scope: 'member', subjectUserId: m.user_id, email: m.email })
                  }
                  onRemove={remove}
                />
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      {editing && (
        <BudgetDialog
          target={editing}
          existing={
            editing.scope === 'project' ? projectBudget : memberBudget(editing.subjectUserId)
          }
          saving={setBudget.isPending}
          onClose={() => setEditing(null)}
          onSave={(input) =>
            setBudget.mutate(
              {
                scope: editing.scope,
                subject_user_id: editing.scope === 'member' ? editing.subjectUserId : null,
                ...input,
              },
              {
                onSuccess: () => {
                  toast.success('Budget saved');
                  setEditing(null);
                },
                onError: (e) =>
                  toast.error(e instanceof Error ? e.message : 'Could not save budget'),
              },
            )
          }
        />
      )}
    </div>
  );
}

function MemberRow({
  member,
  maxCost,
  budget,
  onSetCap,
  onRemove,
}: {
  member: GatewayMemberSpend;
  maxCost: number;
  budget: GatewayBudgetRow | null;
  onSetCap: () => void;
  onRemove: (id: string) => void;
}) {
  const label = member.email ?? 'Unknown member';
  const relPct = Math.max(3, Math.min(100, (member.cost / maxCost) * 100));
  return (
    <div className="flex items-center gap-3">
      <UserAvatar email={member.email ?? ''} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 flex items-center justify-between gap-3">
          <span className="truncate text-sm text-foreground">{label}</span>
          <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
            {fmtUsd(member.cost)}
            {budget ? ` / ${fmtUsd(budget.limit_usd)}` : ''} · {member.requests.toLocaleString()} req
          </span>
        </div>
        {budget ? (
          <Meter spent={member.cost} limit={budget.limit_usd} />
        ) : (
          <div className="h-2 overflow-hidden rounded-full bg-primary/[0.06]">
            <div
              className="h-full rounded-full bg-primary/30 transition-[width] duration-700 ease-out"
              style={{ width: `${relPct}%` }}
            />
          </div>
        )}
      </div>
      {budget ? (
        <button
          type="button"
          onClick={() => onRemove(budget.budget_id)}
          className="shrink-0 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          Remove
        </button>
      ) : (
        <Button size="sm" variant="ghost" className="shrink-0" onClick={onSetCap}>
          Set cap
        </Button>
      )}
    </div>
  );
}

function BudgetDialog({
  target,
  existing,
  saving,
  onClose,
  onSave,
}: {
  target: EditTarget;
  existing: GatewayBudgetRow | null;
  saving: boolean;
  onClose: () => void;
  onSave: (input: {
    limit_usd: number;
    period: 'day' | 'week' | 'month';
    action: 'block' | 'warn';
  }) => void;
}) {
  const [limit, setLimit] = useState(existing ? String(existing.limit_usd) : '');
  const [period, setPeriod] = useState<'day' | 'week' | 'month'>(existing?.period ?? 'month');
  const [action, setAction] = useState<'block' | 'warn'>(existing?.action ?? 'block');

  const who =
    target.scope === 'project' ? 'this project' : (target.email ?? 'this member');
  const amount = Number(limit);
  const valid = Number.isFinite(amount) && amount > 0;

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="border-b border-border/60 px-6 pt-6 pb-4">
          <DialogTitle>{target.scope === 'project' ? 'Project budget' : 'Member cap'}</DialogTitle>
          <DialogDescription>Cap gateway spend for {who}.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 px-6 py-5">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Limit (USD)</label>
            <Input
              autoFocus
              inputMode="decimal"
              placeholder="e.g. 50"
              value={limit}
              onChange={(e) => setLimit(e.target.value.replace(/[^0-9.]/g, ''))}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Period</label>
            <PillGroup options={PERIODS} value={period} onChange={setPeriod} />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">At limit</label>
            <PillGroup options={ACTIONS} value={action} onChange={setAction} />
            <p className="text-xs text-muted-foreground">
              {action === 'block'
                ? 'New requests are blocked once the limit is reached.'
                : 'Requests keep flowing; the bar just turns over-budget.'}
            </p>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border/60 bg-muted/30 px-6 py-3">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!valid || saving}
            onClick={() => valid && onSave({ limit_usd: amount, period, action })}
          >
            {saving ? 'Saving…' : 'Save budget'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PillGroup<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-full border border-border/60 bg-card p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            'flex-1 rounded-full px-3 py-1 text-xs font-medium transition-colors',
            value === o.value
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
