'use client';

import { useLocalizedUiCatalog } from '@/i18n/use-localized-ui-catalog';
import { useLocale, useTranslations } from '@/i18n/use-translations';
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
 *  - The project cap renders as ONE line (`$12.40 of $50.00 per month · blocks
 *    at limit · 25% used`) with a meter and the reset time under it. No second
 *    big number.
 *  - Per-member caps stay — they are a real capability, not decoration — but
 *    as a compact list under the project cap, in the same panel, instead of a
 *    panel of their own.
 *  - `BudgetDialog` is unchanged in shape and already IS the plain form the
 *    brief asks for: an amount, a period, block-or-warn. Both scopes use it.
 *
 * ## Every meter reads its own budget's period
 *
 * A meter, its percentage and its alert read the budget's `spent_usd`: the
 * spend in that budget's day, week or month, the number the gateway compares
 * with the limit. They used to read month-to-date spend, so a $20/day budget
 * with $15 today and $280 this month read 1400% under "Budget exceeded" while
 * the gateway still admitted requests (KRTX-1725).
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

// "per day", "per week", "per month".
const PER_PERIOD_KEY = {
  day: 'text489b7ab47238',
  week: 'textcdca8801db76',
  month: 'text88b1d1a67e34',
} as const;

function fmtUsd(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

/** Spend in the budget's own period, as a percentage of its limit. */
function usedPct(budget: GatewayBudgetRow): number {
  return budget.limit_usd > 0 ? ((budget.spent_usd ?? 0) / budget.limit_usd) * 100 : 0;
}

/** The reset time in the viewer's time zone, with the zone named: a period ends at 00:00 UTC. */
function fmtReset(iso: string | undefined, locale: string): string | null {
  if (!iso) return null;
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(iso));
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
        className={cn('h-full rounded-full', meterTone(pct))}
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const locale = useLocale();
  const { data } = useGatewayBudgets(projectId);
  const setBudget = useSetGatewayBudget(projectId);
  const delBudget = useDeleteGatewayBudget(projectId);
  const [editing, setEditing] = useState<EditTarget | null>(null);

  const budgets = data?.budgets ?? [];
  const members = data?.members ?? [];
  const projectBudget = budgets.find((b) => b.scope === 'project') ?? null;
  const memberBudget = (uid: string | null): GatewayBudgetRow | null =>
    budgets.find((b) => b.scope === 'member' && b.subject_user_id === uid) ?? null;

  const remove = (budgetId: string) =>
    delBudget.mutate(budgetId, {
      onSuccess: () => successToast(tI18nComplete.raw('text663742f42a78')),
      onError: (e) =>
        errorToast(e instanceof Error ? e.message : tI18nComplete.raw('text8a345d23f9f6')),
    });

  // A member budget alerts even when its member has no spend this month: a
  // week can start in the previous month.
  const alerts = budgets
    .map((b) => ({
      budget: b,
      label:
        b.scope === 'project'
          ? tI18nComplete.raw('text985959785319')
          : (members.find((m) => m.user_id === b.subject_user_id)?.email ??
            tI18nComplete.raw('text239ee7bae236')),
      pct: usedPct(b),
    }))
    .filter((a) => a.pct >= 80)
    .sort((a, b) => b.pct - a.pct);
  const exceeded = alerts.some((a) => a.pct >= 100);
  const projectReset = fmtReset(projectBudget?.resets_at, locale);

  return (
    <>
      {alerts.length > 0 && (
        <InfoBanner
          tone={exceeded ? 'destructive' : 'warning'}
          title={
            exceeded ? tI18nComplete.raw('text7689a34422be') : tI18nComplete.raw('text05126477f420')
          }
        >
          {alerts.map((a) => {
            const reset = fmtReset(a.budget.resets_at, locale);
            return (
              <div key={a.budget.budget_id} className="tabular-nums">
                {a.label} —{' '}
                {a.pct >= 100
                  ? tI18nComplete.raw('text2743ed9c1ab8')
                  : tI18nComplete('texteb5de9e6bbb3', { value0: Math.round(a.pct) })}
                {reset ? ` · ${tI18nComplete('text2b8fcd81df9b', { value0: reset })}` : null}
              </div>
            );
          })}
        </InfoBanner>
      )}

      <Panel
        title={tI18nComplete.raw('text1c6225ec7092')}
        description={tI18nComplete.raw('textbf9a0f6614bb')}
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
                  {tI18nComplete.raw('textc3812fc4acb8')}
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => setEditing({ scope: 'project' })}>
                {projectBudget
                  ? tI18nComplete.raw('text464c4ffd019e')
                  : tI18nComplete.raw('textdf4e88af065d')}
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
                <span className="font-medium">{fmtUsd(projectBudget.spent_usd ?? 0)}</span>
                <span className="text-muted-foreground">
                  {tI18nComplete.raw('text28391d3bc64e')} {fmtUsd(projectBudget.limit_usd)}{' '}
                  {tI18nComplete.raw(PER_PERIOD_KEY[projectBudget.period])} ·{' '}
                  {projectBudget.action === 'block'
                    ? tI18nComplete.raw('texta34c2be0a636')
                    : tI18nComplete.raw('textdbe46defeac2')}{' '}
                  · {Math.round(usedPct(projectBudget))}
                  {tI18nComplete.raw('text19e8fbbc0d7b')}
                </span>
              </div>
              <Meter spent={projectBudget.spent_usd ?? 0} limit={projectBudget.limit_usd} />
              {projectReset && (
                <p className="text-muted-foreground text-xs tabular-nums">
                  {tI18nComplete('text2b8fcd81df9b', { value0: projectReset })}
                </p>
              )}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">{tI18nComplete.raw('texta60137ff4904')}</p>
          )}

          {members.length > 0 && (
            <div className="border-border/60 space-y-3 border-t pt-4">
              <p className="text-muted-foreground text-xs">
                {tI18nComplete.raw('textfd94861c802e')}
                {members.length} {members.length === 1 ? 'member' : 'members'}{' '}
                {tI18nComplete.raw('text21c3f4d1d0d0')}
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
                  successToast(tI18nComplete.raw('text27593c2cec19'));
                  setEditing(null);
                },
                onError: (e) =>
                  errorToast(
                    e instanceof Error ? e.message : tI18nComplete.raw('text1ff455ad5cf0'),
                  ),
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
 * bar means something. With a cap, the figure is the spend in the cap's
 * period; without one, it is this month's spend.
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const label = member.email ?? tI18nComplete.raw('text29824c5acaf8');
  return (
    <div className="flex items-center gap-3">
      <UserAvatar email={member.email ?? ''} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <span className="text-foreground truncate text-sm">{label}</span>
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
            {budget
              ? `${fmtUsd(budget.spent_usd ?? 0)} ${tI18nComplete.raw('text28391d3bc64e')} ${fmtUsd(budget.limit_usd)} ${tI18nComplete.raw(PER_PERIOD_KEY[budget.period])}`
              : fmtUsd(member.cost)}
          </span>
        </div>
        {budget && (
          <Meter spent={budget.spent_usd ?? 0} limit={budget.limit_usd} className="mt-1.5" />
        )}
      </div>
      {canWrite &&
        (budget ? (
          <button
            type="button"
            onClick={() => onRemove(budget.budget_id)}
            className="text-muted-foreground hover:text-foreground shrink-0 text-xs transition-colors"
          >
            {tI18nComplete.raw('textc3812fc4acb8')}
          </button>
        ) : (
          <Button size="sm" variant="ghost" className="shrink-0" onClick={onSetCap}>
            {tI18nComplete.raw('text05ba3d9821ab')}
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const periods = useLocalizedUiCatalog(PERIODS);
  const actions = useLocalizedUiCatalog(ACTIONS);
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
          <ModalTitle>
            {target.scope === 'project'
              ? tI18nComplete.raw('textedfb4ed7afaf')
              : tI18nComplete.raw('text10dbcac3bc2c')}
          </ModalTitle>
          <ModalDescription>
            {tI18nComplete.raw('texte80b27e5e39d')} {who}.
          </ModalDescription>
        </ModalHeader>
        <ModalBody className="space-y-4">
          <div className="space-y-1.5">
            <Label>{tI18nComplete.raw('textc6f380561a26')}</Label>
            <Input
              autoFocus
              inputMode="decimal"
              placeholder={tI18nComplete.raw('text5f448b8c41a4')}
              value={limit}
              onChange={(e) => setLimit(e.target.value.replace(/[^0-9.]/g, ''))}
              variant="popover"
            />
          </div>
          <div className="space-y-1.5">
            <Label>{tI18nComplete.raw('text6e795d4d3cc2')}</Label>
            <PillGroup options={periods} value={period} onChange={setPeriod} />
          </div>
          <div className="space-y-1.5">
            <Label>{tI18nComplete.raw('textcfac8a356cfe')}</Label>
            <PillGroup options={actions} value={action} onChange={setAction} />
            <p className="text-muted-foreground text-xs text-pretty">
              {action === 'block'
                ? tI18nComplete.raw('textb66d289c5384')
                : tI18nComplete.raw('textbd5edd378cd3')}
            </p>
          </div>
        </ModalBody>
        <ModalFooter className="sm:justify-between">
          <Button type="button" variant="outline-ghost" onClick={onClose}>
            {tI18nComplete.raw('text19766ed6ccb2')}
          </Button>
          <Button
            disabled={!valid || saving}
            onClick={() => valid && onSave({ limit_usd: amount, period, action })}
          >
            {saving ? <Loading className="size-4 shrink-0" /> : null}
            {tI18nComplete.raw('text6520b66830b2')}
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
