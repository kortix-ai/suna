'use client';

import UsageLogs from '@/components/billing/usage-logs';
import { useAccounts } from '@/hooks/use-accounts';

export default function UsageLogsPage() {
  const { data: accounts } = useAccounts();
  const personalAccount = accounts?.find((account) => account.personal_account);

  if (!personalAccount) {
    return (
      <div className="space-y-6">
        <div>
          <h3 className="text-lg font-medium text-card-title">Usage Logs</h3>
          <p className="text-sm text-foreground/70">
            Loading account information...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-card-title">Usage Logs</h3>
        <p className="text-sm text-foreground/70">
          View detailed usage logs and cost breakdown for your AI agent interactions.
        </p>
      </div>
      <UsageLogs accountId={personalAccount.account_id} />
    </div>
  );
}
