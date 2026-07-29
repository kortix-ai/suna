'use client';

/**
 * Per-end-user metering — the answer to "who spent this?" when upstream bills
 * the whole account once.
 *
 * Three separate upstream reads are shown as three separate things on purpose:
 * this end-user's own line (`?end_user_ref=<me>`), the per-end-user split
 * (`?group_by=end_user_ref`), and the account total (no grouping, no filter).
 * The rows do NOT add up to the total, and the panel says so with the actual
 * arithmetic rather than a footnote — a founder who reads a short breakdown as
 * "the total" concludes money has gone missing.
 */

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import type { UsageResponse } from '@/app/usage/contract';
import { AlertTriangle, UserRound } from 'lucide-react';

function usd(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : `$${n.toFixed(4)}`;
}

/** An upstream read that FAILED must never render as a zero. */
function ReadFailure({ label, message }: { label: string; message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
      <div className="min-w-0">
        <div className="font-medium text-destructive">{label} could not be read</div>
        <div className="mt-0.5 break-words text-muted-foreground">{message}</div>
        <div className="mt-0.5 text-muted-foreground">
          Treat this as unknown, not as zero.
        </div>
      </div>
    </div>
  );
}

export function UsageEndUserBreakdown({ data }: { data: UsageResponse }) {
  const attributed = data.by_end_user.reduce((sum, bill) => sum + bill.rawCost, 0);

  return (
    <Card className="mt-6 overflow-hidden p-0">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <UserRound className="size-4 text-muted-foreground" />
          <div className="text-sm font-medium">Spend by end-user</div>
          <Badge variant="secondary" className="font-mono text-[11px]">
            group_by=end_user_ref
          </Badge>
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          Upstream bills this account once. <code>end_user_ref</code> is what splits that bill back
          out. The label below is the email you signed in with — this app stamps it onto every
          session create server-side, from the verified session. The browser cannot set it, which is
          the only reason a row here can be trusted to mean what it says.
        </p>
      </div>

      {/* This end-user's own line, from the narrowed query — the exact call a
          wrapper runs to answer "what does this customer owe me". */}
      <div className="border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">You</span>
            <span className="break-all font-mono text-xs">{data.endUserRef}</span>
            <Badge variant="outline" className="font-mono text-[11px]">
              end_user_ref=&lt;me&gt;
            </Badge>
          </div>
          {data.mine && (
            <div className="text-right">
              <div className="text-lg font-semibold tabular-nums">{usd(data.mine.rawCost)}</div>
              <div className="text-xs text-muted-foreground">
                {data.mine.sessions} charge{data.mine.sessions === 1 ? '' : 's'} · you&apos;d bill{' '}
                {usd(data.mine.billedCost)}
              </div>
            </div>
          )}
        </div>
        {data.mineError && (
          <div className="mt-2">
            <ReadFailure label="Your own spend" message={data.mineError} />
          </div>
        )}
      </div>

      {data.groupedError ? (
        <div className="px-4 py-3">
          <ReadFailure label="The per-end-user breakdown" message={data.groupedError} />
        </div>
      ) : data.by_end_user.length === 0 ? (
        <p className="px-4 py-4 text-xs text-muted-foreground">
          No attributed spend yet. A row appears here once a session created through this app
          records usage.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th className="px-4 py-2 text-left font-normal">End-user</th>
                <th className="px-4 py-2 text-right font-normal">Charges</th>
                <th className="px-4 py-2 text-right font-normal">Cost</th>
                <th className="px-4 py-2 text-right font-normal">You charge</th>
              </tr>
            </thead>
            <tbody>
              {data.by_end_user.map((bill) => (
                <tr key={bill.endUserRef} className="border-b border-border last:border-b-0">
                  <td className="px-4 py-2 font-mono text-xs">
                    {bill.endUserRef}
                    {bill.endUserRef === data.endUserRef && (
                      <span className="ml-2 text-muted-foreground">(you)</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{bill.sessions}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                    {usd(bill.rawCost)}
                  </td>
                  <td className="px-4 py-2 text-right font-medium tabular-nums">
                    {usd(bill.billedCost)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* The caveat, with the subtraction spelled out. Rows with NO end_user_ref
          — dashboard sessions, anything created before the field existed — are
          excluded from the grouping by upstream but still counted in the
          account total, so these two numbers are SUPPOSED to disagree. */}
      <div className="border-t border-border bg-muted/30 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
        <div className="font-medium text-foreground">
          These rows do not add up to the account total, and that is correct.
        </div>
        <p className="mt-1">
          Spend with no <code>end_user_ref</code> — sessions started from the Kortix dashboard, and
          anything predating the field — is excluded from the grouped breakdown but still counted in
          the account total. It is nobody&apos;s to bill, so it is left out rather than spread across
          whoever sorts first.
        </p>
        {data.operator ? (
          data.accountTotalError ? (
            <div className="mt-2">
              <ReadFailure label="The account total" message={data.accountTotalError} />
            </div>
          ) : (
            <dl className="mt-2 space-y-1">
              <div className="flex justify-between gap-4">
                <dt>Account total (no grouping, no filter)</dt>
                <dd className="tabular-nums text-foreground">{usd(data.accountTotal?.rawCost)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>Attributed to an end-user (the rows above)</dt>
                <dd className="tabular-nums text-foreground">{usd(Math.round(attributed * 100) / 100)}</dd>
              </div>
              <div className="flex justify-between gap-4 border-t border-border pt-1">
                <dt>Unattributed — real spend, nobody to bill</dt>
                <dd className="tabular-nums text-foreground">{usd(data.unattributed_cost)}</dd>
              </div>
            </dl>
          )
        ) : (
          <p className="mt-2">
            The account total and every other end-user&apos;s row are hidden — showing them here
            would let any signed-in user read every other user&apos;s id and spend. The breakdown
            above is narrowed to you. Set{' '}
            <code className="font-mono">{data.operatorEnvVar}=1</code> to turn the account-wide
            split on for this whole deployment, and see the arithmetic behind this caveat. It is a
            deployment switch, not a per-user permission: this demo&apos;s login accepts any email,
            so an allowlist of addresses would name a user without authenticating one.
          </p>
        )}
      </div>
    </Card>
  );
}
