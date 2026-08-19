'use client';

/**
 * Budget — the spend cap for this project's gateway.
 *
 * ## A section of Overview, not a tab
 *
 * It was its own tab, and it opened on a full-width panel whose headline was a
 * 2xl dollar figure — the SAME figure the Overview tab's "Total spend" stat
 * card already showed, one tab away, formatted differently. Two screens
 * answering "how much has this project spent?" and only one of them able to
 * change anything about it. It is now the section directly under those stats,
 * where the number it caps is already on screen: read the spend, cap the
 * spend, in one column.
 *
 * ## What got cut
 *
 * The old tab led with a bar chart of the project's own spend against its cap,
 * a percentage in 2xl type, a remaining figure, and a member list with a
 * second meter per member — a dashboard for one number. What is left is the
 * cap itself: the limit, the period, and what happens at the limit.
 *
 *  - The project cap renders as ONE line (`$12.40 of $50 / month · blocks at
 *    limit`) with a meter under it. No second big number.
 *  - Per-member caps stay — they are a real capability, not decoration — but
 *    as a compact list under the project cap, in the same panel, instead of a
 *    panel of their own.
 *  - `BudgetDialog` is unchanged in shape and already IS the plain form the
 *    brief asks for: an amount, a period, block-or-warn. Both scopes use it.
 *
 * ## No per-GROUP cap
 *
 * `gateway_budget_scope` is `('project','member')` in the database
 * (`packages/db/src/schema/kortix.ts:2808`) and in the route body schema
 * (`apps/api/src/projects/routes/gateway.ts:565`), and `gateway_budgets` has
 * no `subject_group_id` column. Account groups exist elsewhere
 * (`kortix.account_groups` + `project_group_grants`) but nothing in the budget
 * path references them. A group cap is backend work, not a control this file
 * may invent — see the handover notes.
 */

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { FilterBar, FilterBarItem } from '@/components/ui/tabs';
import { errorToast, successToast } from '@/components/ui/toast';
import { UserAvatar } from '@/components/ui/user-avatar';
import {
  useDeleteGatewayBudget,
  useGatewayBudgets,
  useSetGatewayBudget,
} from '@/hooks/projects/use-project-gateway';
import type { GatewayBudgetRow, GatewayMemberSpend } from '@/lib/projects-gateway-client';
import { cn } from '@/lib/utils';

import { Panel } from './_shared';

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

function Meter({ spent, limit, className }: { spent: number; limit: number; className?: string }) {
  const pct = limit > 0 ? (spent / limit) * 100 : 0;
  return (
    <div className={cn('bg-primary/[0.06] h-2 overflow-hidden rounded-full', className)}>
      <div
        className={cn(
          'h-full rounded-full transition-[width] duration-700 ease-out',
          meterTone(pct),
        )}
        style={{ width: `${Math.min(100, pct)}%` }}
      />
    </div>
  );
}

type EditTarget =
  { scope: 'project' } | { scope: 'member'; subjectUserId: string; email: string | null };

/**
 * The whole budget feature, as one panel. Renders bare — no scroll container
 * and no page padding — so `GatewayOverview` can drop it into its column.
 */
export function GatewayBudgetSection({
  projectId,
  canWrite = false,
}: {
  projectId: string;
  canWrite?: boolean;
}) {
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
      onSuccess: () => successToast('Budget removed'),
      onError: (e) => errorToast(e instanceof Error ? e.message : 'Could not remove budget'),
    });

  const alerts: { label: string; pct: number }[] = [];
  if (
    projectBudget &&
    projectBudget.limit_usd > 0 &&
    projectSpend / projectBudget.limit_usd >= 0.8
  ) {
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

  const pct =
    projectBudget && projectBudget.limit_usd > 0
      ? (projectSpend / projectBudget.limit_usd) * 100
      : 0;

  return (
    <>
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

      <Panel
        title="Budget"
        description="Cap what this project can spend through the gateway"
        action={
          canWrite ? (
            <div className="flex items-center gap-1">
              {projectBudget && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => remove(projectBudget.budget_id)}
                >
                  Remove
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => setEditing({ scope: 'project' })}>
                {projectBudget ? 'Edit' : 'Set budget'}
              </Button>
            </div>
          ) : undefined
        }
      >
        <div className="space-y-4">
          {projectBudget ? (
            <div className="space-y-2">
              {/* One line, not a headline. "Total spend" two rows up already
                  states the figure in large type; repeating it here is what
                  made two screens out of one number. */}
              <div className="text-foreground flex flex-wrap items-baseline gap-x-1.5 text-sm tabular-nums">
                <span className="font-medium">{fmtUsd(projectSpend)}</span>
                <span className="text-muted-foreground">
                  of {fmtUsd(projectBudget.limit_usd)} per {projectBudget.period} ·{' '}
                  {projectBudget.action === 'block' ? 'blocks at limit' : 'warns only'} ·{' '}
                  {Math.round(pct)}% used
                </span>
              </div>
              <Meter spent={projectSpend} limit={projectBudget.limit_usd} />
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              No cap. This project&apos;s gateway spend is unlimited.
            </p>
          )}

          {members.length > 0 && (
            <div className="border-border/60 space-y-3 border-t pt-4">
              <p className="text-muted-foreground text-xs">
                Per-member caps ({members.length} {members.length === 1 ? 'member' : 'members'} with
                spend this month)
              </p>
              {members.map((m) => (
                <MemberRow
                  key={m.user_id ?? 'unknown'}
                  member={m}
                  budget={memberBudget(m.user_id)}
                  canWrite={canWrite}
                  onSetCap={() =>
                    m.user_id &&
                    setEditing({ scope: 'member', subjectUserId: m.user_id, email: m.email })
                  }
                  onRemove={remove}
                />
              ))}
            </div>
          )}
        </div>
      </Panel>

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
                  successToast('Budget saved');
                  setEditing(null);
                },
                onError: (e) =>
                  errorToast(e instanceof Error ? e.message : 'Could not save budget'),
              },
            )
          }
        />
      )}
    </>
  );
}

/**
 * One member's spend and cap, on one line.
 *
 * The relative-spend meter every member used to carry is gone: without a cap
 * it charted each member against the biggest spender, which looks like a
 * limit and is not one. A member with a cap still gets a real meter — that
 * bar means something.
 */
function MemberRow({
  member,
  budget,
  canWrite,
  onSetCap,
  onRemove,
}: {
  member: GatewayMemberSpend;
  budget: GatewayBudgetRow | null;
  canWrite: boolean;
  onSetCap: () => void;
  onRemove: (id: string) => void;
}) {
  const label = member.email ?? 'Unknown member';
  return (
    <div className="flex items-center gap-3">
      <UserAvatar email={member.email ?? ''} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <span className="text-foreground truncate text-sm">{label}</span>
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
            {fmtUsd(member.cost)}
            {budget ? ` of ${fmtUsd(budget.limit_usd)}` : ''}
          </span>
        </div>
        {budget && <Meter spent={member.cost} limit={budget.limit_usd} className="mt-1.5" />}
      </div>
      {canWrite &&
        (budget ? (
          <button
            type="button"
            onClick={() => onRemove(budget.budget_id)}
            className="text-muted-foreground hover:text-foreground shrink-0 text-xs transition-colors"
          >
            Remove
          </button>
        ) : (
          <Button size="sm" variant="ghost" className="shrink-0" onClick={onSetCap}>
            Set cap
          </Button>
        ))}
    </div>
  );
}

/** The whole budget form: an amount, a period, and what happens at the limit. */
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

  const who = target.scope === 'project' ? 'this project' : (target.email ?? 'this member');
  const amount = Number(limit);
  const valid = Number.isFinite(amount) && amount > 0;

  return (
    <Modal open onOpenChange={(next) => (next ? undefined : onClose())}>
      <ModalContent className="sm:max-w-md">
        <ModalHeader>
          <ModalTitle>{target.scope === 'project' ? 'Project budget' : 'Member cap'}</ModalTitle>
          <ModalDescription>Cap gateway spend for {who}.</ModalDescription>
        </ModalHeader>
        <ModalBody className="space-y-4">
          <div className="space-y-1.5">
            <Label>Limit (USD)</Label>
            <Input
              autoFocus
              inputMode="decimal"
              placeholder="e.g. 50"
              value={limit}
              onChange={(e) => setLimit(e.target.value.replace(/[^0-9.]/g, ''))}
              variant="popover"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Period</Label>
            <PillGroup options={PERIODS} value={period} onChange={setPeriod} />
          </div>
          <div className="space-y-1.5">
            <Label>At limit</Label>
            <PillGroup options={ACTIONS} value={action} onChange={setAction} />
            <p className="text-muted-foreground text-xs text-pretty">
              {action === 'block'
                ? 'New requests are blocked once the limit is reached.'
                : 'Requests keep flowing; the bar just turns over-budget.'}
            </p>
          </div>
        </ModalBody>
        <ModalFooter className="sm:justify-between">
          <Button type="button" variant="outline-ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!valid || saving}
            onClick={() => valid && onSave({ limit_usd: amount, period, action })}
          >
            {saving ? <Loading className="size-4 shrink-0" /> : null}
            Save budget
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
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
    <FilterBar className="w-full">
      {options.map((o) => (
        <FilterBarItem
          key={o.value}
          onClick={() => onChange(o.value)}
          data-state={value === o.value ? 'active' : 'inactive'}
          className="text-xs"
        >
          {o.label}
        </FilterBarItem>
      ))}
    </FilterBar>
  );
}
