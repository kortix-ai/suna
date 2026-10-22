'use client';

import { useFirm } from '@/components/access';
import { PageBody, PageHeader } from '@/components/page';
import { HistoryList } from '@/components/runs/history-list';
import { isAdmin } from '@/lib/roles';
import { api } from '@convex/_generated/api';
import { useQuery } from 'convex/react';

export default function FirmHistoryPage() {
  const firm = useFirm();
  const items = useQuery(api.workflows.firmHistory, { firmId: firm._id });
  return (
    <PageBody>
      <PageHeader
        title="History"
        description={isAdmin(firm.role) ? 'Every run and conversation at the firm, newest first.' : 'Every run and conversation in the matters you can open, newest first.'}
      />
      <div className="mt-6">
        <HistoryList items={items} showMatter empty="Runs and conversations appear here once someone asks a question or starts a workflow." />
      </div>
    </PageBody>
  );
}
