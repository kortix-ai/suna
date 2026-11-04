export type Evidence = {
  complete: boolean;
  unsupported: boolean;
  subscriptions: { status: string; amount: number | null }[];
};

export function customerStatus(accounts: Evidence[]): boolean | null {
  if (accounts.some((account) => account.subscriptions.some((sub) => sub.status === 'active' && sub.amount !== null && Number.isFinite(sub.amount) && sub.amount > 0))) return true;
  if (!accounts.length || accounts.some((account) => !account.complete || account.unsupported || !account.subscriptions.length ||
    account.subscriptions.some((sub) => !['active', 'canceled', 'incomplete_expired'].includes(sub.status) ||
      (sub.status === 'active' && sub.amount !== 0)))) return null;
  return false;
}
