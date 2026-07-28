/**
 * What Lumen charges each of ITS OWN users.
 *
 * Upstream bills Lumen once, for the whole account. `end_user_ref` — which the
 * proxy stamps from the signed-in session — is what lets us split that bill back
 * out per end-user, which is the entire point of running as a wrapper.
 */

export interface UpstreamEndUserRow {
  end_user_ref?: string;
  /** Deprecated alias an older upstream may still be the only one sending. */
  origin_ref?: string;
  cost?: number;
  count?: number;
}

export interface EndUserBill {
  endUserRef: string;
  rawCost: number;
  billedCost: number;
  sessions: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Split an upstream `group_by=end_user_ref` rollup into per-end-user bills.
 *
 * Rows with no handle are DROPPED, never spread across users: unattributed
 * spend is Lumen's own (dashboard sessions, anything predating the field), and
 * charging it to whoever happens to sort first would be worse than not billing
 * it at all. The caller is told how much was dropped so the gap is visible
 * rather than silently absorbed.
 */
export function splitEndUserBills(
  rows: UpstreamEndUserRow[] | undefined,
  markup: number,
): { bills: EndUserBill[]; unattributedCost: number } {
  let unattributed = 0;
  const bills: EndUserBill[] = [];

  for (const row of rows ?? []) {
    const ref = (row.end_user_ref ?? row.origin_ref ?? '').trim();
    const cost = row.cost ?? 0;
    if (ref.length === 0) {
      unattributed += cost;
      continue;
    }
    bills.push({
      endUserRef: ref,
      rawCost: round2(cost),
      billedCost: round2(cost * markup),
      sessions: row.count ?? 0,
    });
  }

  bills.sort((a, b) => b.billedCost - a.billedCost || a.endUserRef.localeCompare(b.endUserRef));
  return { bills, unattributedCost: round2(unattributed) };
}
