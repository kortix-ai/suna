export function formatSessionCostUsd(value: number): string {
  const cost = Number.isFinite(value) ? value : 0;
  return cost.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: Math.abs(cost) > 0 && Math.abs(cost) < 0.01 ? 10 : 2,
  });
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
