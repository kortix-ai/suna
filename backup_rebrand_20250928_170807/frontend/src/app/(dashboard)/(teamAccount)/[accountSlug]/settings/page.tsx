'use client';

import React from 'react';
import EditTeamName from '@/components/basejump/edit-team-name';
import EditTeamSlug from '@/components/basejump/edit-team-slug';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { createClient } from '@/lib/supabase/server';

type AccountParams = {
  accountSlug: string;
};

export default function TeamSettingsPage({
  params,
}: {
  params: Promise<AccountParams>;
}) {
  const unwrappedParams = React.use(params);
  const { accountSlug } = unwrappedParams;

  // Use an effect to load team account data
  const [teamAccount, setTeamAccount] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    async function loadData() {
      try {
        const supabaseClient = await createClient();
        const { data } = await supabaseClient.rpc('get_account_by_slug', {
          slug: accountSlug,
        });
        setTeamAccount(data);
        setLoading(false);
      } catch (err) {
        setError('Failed to load account data');
        setLoading(false);
        console.error(err);
      }
    }

    loadData();
  }, [accountSlug]);

  if (loading) {
    return <div>Loading...</div>;
  }

  if (!teamAccount) {
    return <div>Account not found</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-card-title">Team Settings</h3>
        <p className="text-sm text-foreground/70">
          Manage your team account details.
        </p>
      </div>

      <Card className="border-subtle dark:border-white/10 bg-white dark:bg-background-secondary shadow-none">
        <CardHeader>
          <CardTitle className="text-base text-card-title">Team Name</CardTitle>
          <CardDescription>Update your team name.</CardDescription>
        </CardHeader>
        <CardContent>
          <EditTeamName account={teamAccount} />
        </CardContent>
      </Card>

      <Card className="border-subtle dark:border-white/10 bg-white dark:bg-background-secondary shadow-none">
        <CardHeader>
          <CardTitle className="text-base text-card-title">Team URL</CardTitle>
          <CardDescription>Update your team URL slug.</CardDescription>
        </CardHeader>
        <CardContent>
          <EditTeamSlug account={teamAccount} />
        </CardContent>
      </Card>
    </div>
  );
}
