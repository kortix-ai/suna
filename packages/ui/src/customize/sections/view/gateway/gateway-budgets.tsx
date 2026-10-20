'use client';

import { useLocalizedUiCatalog } from '../../../../i18n/ui-catalog/use-localized-ui-catalog';
import { useLocale, useTranslations } from '../../../../i18n';
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
 *  - The project cap renders as ONE line (`1,240 of 5,000 credits this month`) with a
 *    meter under it and what happens at the limit. No second big number.
 *  - Per-member caps stay — they are a real capability, not decoration — as
 *    one row per member under the project cap: spend, a meter and "N% of cap"
 *    when capped, Edit cap / Remove or Set cap.
 *  - `BudgetDialog` is unchanged in shape and already IS the plain form the
 *    brief asks for: an amount, a period, block-or-warn. Both scopes use it.
 *
 * ## Credits on screen, USD on the wire
 *
 * Spend and limits read in credits (1 credit = $0.01): a cap is an amount the
 * project spends, not a price. The API keeps `limit_usd` and `spent_usd`; the
 * dialog takes credits and sends `credits / 100` (`budgetLimitUsd`).
 *
 * ## Every meter reads its own budget's period
 *
 * A meter, its percentage and its alert read the budget's `spent_usd`: the
 * spend in that budget's day, week or month, the number the gateway compares
 * with the limit. They used to read month-to-date spend, so a $20/day budget
 * with $15 today and $280 this month read 1400% under "Budget exceeded" while
 * the gateway still admitted requests (KRTX-1725). An older API sends no
 * `spent_usd`: see `periodSpend`.
 *
 * Every member cap has a row and a named alert, also when its member spent
 * nothing this month: the budget carries `subject_email`.
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

import { type ReactNode, useState } from 'react';

import { Button } from '../../../../primitives/button';
import { InfoBanner } from '../../../../primitives/info-banner';
import { Input } from '../../../../primitives/input';
import { Label } from '../../../../primitives/label';
import Loading from '../../../../primitives/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '../../../../primitives/modal';
import { Tabs, TabsList, TabsTrigger } from '../../../../primitives/tabs';
import { errorToast, successToast } from '../../../../primitives/toast';
import { UserAvatar } from '../../../../primitives/user-avatar';
import {
  useDeleteGatewayBudget,
  useGatewayBudgets,
  useSetGatewayBudget,
} from '@kortix/sdk/react';
import type { GatewayBudgetRow, GatewayMemberSpend } from '@kortix/sdk';
import { cn } from '../../../../internal/lib/utils';

import { CREDITS_PER_DOLLAR } from '@kortix/shared';

import { CostSection, fmtCredits } from './_metrics';

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

interface PeriodSpend {
  /** Spend in the budget's own period. */
  spent: number;
  /** `spent` as a percentage of the limit. */
  pct: number;
}

/**
 * A budget's spend this period, or null when it is unknown. An API older than
 * KRTX-1725 sends no `spent_usd`: month-to-date spend is the same number for a
 * monthly budget, and a daily or weekly budget gets no meter instead of a
 * false 0%.
 */
function periodSpend(
  budget: GatewayBudgetRow,
  projectMonthCost: number,
  members: GatewayMemberSpend[],
): PeriodSpend | null {
  let spent = budget.spent_usd;
  if (spent === undefined && budget.period === 'month') {
    spent =
      budget.scope === 'project'
        ? projectMonthCost
        : (members.find((m) => m.user_id === budget.subject_user_id)?.cost ?? 0);
  }
  if (spent === undefined) return null;
  return { spent, pct: budget.limit_usd > 0 ? (spent / budget.limit_usd) * 100 : 0 };
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
  return pct >= 100 ? 'bg-destructive' : 'bg-foreground';
}

function Meter({ spent, limit, className }: { spent: number; limit: number; className?: string }) {
  const pct = limit > 0 ? (spent / limit) * 100 : 0;
  return (
    <div
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(Math.min(100, pct))}
      className={cn('bg-muted h-1.5 shrink-0 overflow-hidden rounded-full', className)}
    >
      <div
        className={cn('h-full rounded-full', meterTone(pct))}
        style={{ width: `${Math.min(100, pct)}%` }}
      />
    </div>
  );
}

/** The budget line per period: "3,120 of 5,000 credits this month". */
const BUDGET_LINE = {
  day: 'budgetToday',
  week: 'budgetThisWeek',
  month: 'budgetThisMonth',
} as const;

type EditTarget =
  { scope: 'project' } | { scope: 'member'; subjectUserId: string; email: string | null };

/**
 * The whole budget feature as one Costs section: a title row with the budget
 * action, the project cap's panel, then the member caps' panel. Renders bare —
 * no scroll container and no page padding — so `GatewayOverview` can drop it
 * into its column, directly under the chart.
 */
export function GatewayBudgetSection({
  projectId,
  canWrite = false,
}: {
  projectId: string;
  canWrite?: boolean;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const t = useTranslations('gatewayCosts');
  const locale = useLocale();
  const credits = (usd: number) => fmtCredits(usd, locale);
  const { data } = useGatewayBudgets(projectId);
  const setBudget = useSetGatewayBudget(projectId);
  const delBudget = useDeleteGatewayBudget(projectId);
  const [editing, setEditing] = useState<EditTarget | null>(null);

  const budgets = data?.budgets ?? [];
  const members = data?.members ?? [];
  // `members` lists spend this month only. A member cap gets a row without it,
  // so it can be read, edited and removed.
  const rows: GatewayMemberSpend[] = [
    ...members,
    ...budgets
      .filter((b) => b.scope === 'member' && !members.some((m) => m.user_id === b.subject_user_id))
      .map((b) => ({
        user_id: b.subject_user_id,
        email: b.subject_email ?? null,
        requests: 0,
        cost: 0,
        tokens: 0,
      })),
  ];
  const spendOf = (b: GatewayBudgetRow) => periodSpend(b, data?.project_spend.cost ?? 0, members);
  const projectBudget = budgets.find((b) => b.scope === 'project') ?? null;
  const projectSpend = projectBudget ? spendOf(projectBudget) : null;
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
    .flatMap((b) => {
      const spend = spendOf(b);
      if (!spend || spend.pct < 80) return [];
      const label =
        b.scope === 'project'
          ? tI18nComplete.raw('text985959785319')
          : (rows.find((m) => m.user_id === b.subject_user_id)?.email ??
            tI18nComplete.raw('text239ee7bae236'));
      return [{ budget: b, label, pct: spend.pct }];
    })
    .sort((a, b) => b.pct - a.pct);
  const exceeded = alerts.some((a) => a.pct >= 100);
  const projectReset = fmtReset(projectBudget?.resets_at, locale);

  return (
    <CostSection
      title={tI18nComplete.raw('text1c6225ec7092')}
      description={tI18nComplete.raw('textbf9a0f6614bb')}
      action={
        canWrite ? (
          <div className="flex shrink-0 items-center gap-1">
            {projectBudget && (
              <Button size="sm" variant="ghost" onClick={() => remove(projectBudget.budget_id)}>
                {tI18nComplete.raw('textc3812fc4acb8')}
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={() => setEditing({ scope: 'project' })}>
              {projectBudget ? t('editBudget') : tI18nComplete.raw('textdf4e88af065d')}
            </Button>
          </div>
        ) : undefined
      }
      className="basis-auto"
    >
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

      <div
        className="border-border bg-surface flex flex-col gap-2.5 rounded-md border p-4"
        data-gateway-budget=""
      >
        <div className="flex items-baseline justify-between gap-3 text-xs">
          <span className="text-foreground">{tI18nComplete.raw('text985959785319')}</span>
          {projectBudget ? (
            <span className="text-muted-foreground text-right tabular-nums">
              <span className="text-foreground">
                {projectSpend
                  ? t(BUDGET_LINE[projectBudget.period] ?? 'budgetThisMonth', {
                      spent: credits(projectSpend.spent),
                      limit: credits(projectBudget.limit_usd),
                    })
                  : `${credits(projectBudget.limit_usd)} ${tI18nComplete.raw('textbe379a30f1aa')} ${tI18nComplete.raw(PER_PERIOD_KEY[projectBudget.period])}`}
              </span>{' '}
              · {projectBudget.action === 'block' ? t('blocksAtLimit') : t('warnsAtLimit')}
            </span>
          ) : (
            <span className="text-muted-foreground">{t('noCapUnlimited')}</span>
          )}
        </div>
        {/* No meter for a cap whose period spend is unknown: an empty bar would
            read as 0%. */}
        {(!projectBudget || projectSpend) && (
          <Meter spent={projectSpend?.spent ?? 0} limit={projectBudget?.limit_usd ?? 0} />
        )}
        {projectReset && (
          <p className="text-muted-foreground text-xs tabular-nums">
            {tI18nComplete('text2b8fcd81df9b', { value0: projectReset })}
          </p>
        )}
      </div>

      {rows.length > 0 && (
        <>
          <div className="text-muted-foreground flex items-baseline justify-between gap-3 pt-3 text-xs">
            <span>{t('memberCaps')}</span>
            <span className="tabular-nums">{t('membersWithSpend', { count: members.length })}</span>
          </div>
          <div
            className="border-border bg-surface flex flex-col rounded-md border px-4 pb-1"
            data-gateway-member-caps=""
          >
            {rows.map((m) => {
              const budget = memberBudget(m.user_id);
              return (
                <MemberRow
                  key={m.user_id ?? 'unknown'}
                  member={m}
                  budget={budget}
                  spend={budget ? spendOf(budget) : null}
                  canWrite={canWrite}
                  onSetCap={() =>
                    m.user_id &&
                    setEditing({ scope: 'member', subjectUserId: m.user_id, email: m.email })
                  }
                  onRemove={remove}
                />
              );
            })}
          </div>
        </>
      )}

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
    </CostSection>
  );
}

/**
 * One member's spend and cap, on one row. A member with a cap gets a real
 * meter and "N% of cap"; without one, the row says so instead of charting the
 * member against the biggest spender, which looks like a limit and is not one.
 * With a cap, the figure is the spend in the cap's period; without one, it is
 * this month's spend. A cap whose spend is unknown (`spend` null) shows its
 * limit only.
 */
export function MemberRow({
  member,
  budget,
  spend = null,
  canWrite,
  onSetCap,
  onRemove,
}: {
  member: GatewayMemberSpend;
  budget: GatewayBudgetRow | null;
  spend?: PeriodSpend | null;
  canWrite: boolean;
  onSetCap: () => void;
  onRemove: (id: string) => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const t = useTranslations('gatewayCosts');
  const locale = useLocale();
  const credits = (usd: number) => fmtCredits(usd, locale);
  const label = member.email ?? tI18nComplete.raw('text29824c5acaf8');
  return (
    <div
      className="border-border flex min-h-12 items-center gap-3 border-b py-1.5 last:border-b-0"
      data-member-row=""
    >
      <UserAvatar email={member.email ?? ''} size="sm" />
      <span className="text-foreground min-w-0 flex-1 truncate text-xs">{label}</span>
      <span className="text-foreground w-20 shrink-0 text-right text-xs tabular-nums">
        {credits(budget && spend ? spend.spent : member.cost)}
      </span>
      {budget ? (
        <div className="hidden w-48 shrink-0 items-center gap-3 sm:flex">
          {spend ? (
            <>
              <Meter spent={spend.spent} limit={budget.limit_usd} className="flex-1" />
              <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                {t('ofLimit', { pct: Math.round(spend.pct), limit: credits(budget.limit_usd) })}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground flex-1 text-right text-xs tabular-nums">
              {credits(budget.limit_usd)} {tI18nComplete.raw('textbe379a30f1aa')}{' '}
              {tI18nComplete.raw(PER_PERIOD_KEY[budget.period])}
            </span>
          )}
        </div>
      ) : (
        <span className="text-muted-foreground w-18 shrink-0 text-xs">{t('noCap')}</span>
      )}
      {canWrite ? (
        <div className="flex shrink-0 items-center justify-end gap-3">
          {budget ? (
            <>
              <TextAction onClick={onSetCap}>{t('editCap')}</TextAction>
              <TextAction onClick={() => onRemove(budget.budget_id)}>
                {tI18nComplete.raw('textc3812fc4acb8')}
              </TextAction>
            </>
          ) : (
            <TextAction onClick={onSetCap}>{tI18nComplete.raw('text05ba3d9821ab')}</TextAction>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** A quiet text button: the budget's controls sit in the list's own type. */
function TextAction({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-foreground hover:text-muted-foreground focus-visible:ring-ring/50 rounded-sm text-xs font-medium outline-none focus-visible:ring-2"
    >
      {children}
    </button>
  );
}

/** The limit field's starting text: the stored USD limit in whole credits. */
export function budgetLimitInput(existing: Pick<GatewayBudgetRow, 'limit_usd'> | null): string {
  return existing ? String(Math.round(existing.limit_usd * CREDITS_PER_DOLLAR)) : '';
}

/** The limit field (whole credits) as the `limit_usd` the API takes, or null when not a positive amount. */
export function budgetLimitUsd(input: string): number | null {
  const credits = Number(input);
  if (!input || !Number.isFinite(credits) || credits <= 0) return null;
  return credits / CREDITS_PER_DOLLAR;
}

/** The whole budget form: an amount in credits, a period, and what happens at the limit. */
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
  const [limit, setLimit] = useState(() => budgetLimitInput(existing));
  const [period, setPeriod] = useState<'day' | 'week' | 'month'>(existing?.period ?? 'month');
  const [action, setAction] = useState<'block' | 'warn'>(existing?.action ?? 'block');

  const who = target.scope === 'project' ? 'this project' : (target.email ?? 'this member');
  const limitUsd = budgetLimitUsd(limit);

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
            <Label>{tI18nComplete.raw('textfaaf56a699c2')}</Label>
            <Input
              autoFocus
              inputMode="numeric"
              className="tabular-nums"
              placeholder={tI18nComplete.raw('textc86ce3b8097b')}
              value={limit}
              onChange={(e) => setLimit(e.target.value.replace(/[^0-9]/g, ''))}
              variant="popover"
            />
          </div>
          <div className="space-y-1.5">
            <Label>{tI18nComplete.raw('text6e795d4d3cc2')}</Label>
            <PillGroup
              label={tI18nComplete.raw('text6e795d4d3cc2')}
              options={periods}
              value={period}
              onChange={setPeriod}
              disabled={saving}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{tI18nComplete.raw('textcfac8a356cfe')}</Label>
            <PillGroup
              label={tI18nComplete.raw('textcfac8a356cfe')}
              options={actions}
              value={action}
              onChange={setAction}
              disabled={saving}
            />
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
            disabled={limitUsd === null || saving}
            onClick={() => limitUsd !== null && onSave({ limit_usd: limitUsd, period, action })}
          >
            {saving ? <Loading className="size-4 shrink-0" /> : null}
            {tI18nComplete.raw('text6520b66830b2')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

/** A choice of a few values: the design-system segmented control. */
function PillGroup<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <Tabs
      value={value}
      onValueChange={(next) => {
        const option = options.find((o) => o.value === next);
        if (option) onChange(option.value);
      }}
    >
      <TabsList className="w-full" aria-label={label}>
        {options.map((o) => (
          <TabsTrigger key={o.value} value={o.value} disabled={disabled} className="flex-1">
            {o.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
