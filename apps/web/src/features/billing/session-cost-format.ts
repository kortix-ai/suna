const SUB_CENT_LABEL = '<$0.01';

function toUsd(cost: number, maximumFractionDigits: number): string {
  return cost.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits,
  });
}

// Sub-cent costs collapse to a threshold label so every column decimal-aligns.
// The exact value stays reachable via formatSessionCostExactUsd (tooltips, the
// session ledger), so precision is relocated, not lost.
export function formatSessionCostUsd(value: number): string {
  const cost = Number.isFinite(value) ? value : 0;
  if (cost > 0 && cost < 0.01) return SUB_CENT_LABEL;
  return toUsd(cost, 2);
}

export function formatSessionCostExactUsd(value: number): string {
  const cost = Number.isFinite(value) ? value : 0;
  return toUsd(cost, Math.abs(cost) > 0 && Math.abs(cost) < 0.01 ? 10 : 2);
}

export function formatSessionCostDuration(value: number): string {
  let remaining = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  const units = [
    { label: 'd', seconds: 86_400 },
    { label: 'h', seconds: 3_600 },
    { label: 'm', seconds: 60 },
    { label: 's', seconds: 1 },
  ] as const;
  const parts: string[] = [];

  for (const unit of units) {
    const amount = Math.floor(remaining / unit.seconds);
    remaining %= unit.seconds;
    if (amount > 0 || (unit.label === 's' && parts.length === 0)) {
      parts.push(`${amount}${unit.label}`);
    }
    if (parts.length === 2) break;
  }

  return parts.join(' ');
}
