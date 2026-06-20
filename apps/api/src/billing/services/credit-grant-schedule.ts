export function calculateNextCreditGrant(from: Date): Date {
  const next = new Date(from);
  const targetMonth = (next.getMonth() + 1) % 12;
  next.setMonth(next.getMonth() + 1);
  if (next.getMonth() !== targetMonth) {
    next.setDate(0);
  }
  return next;
}
