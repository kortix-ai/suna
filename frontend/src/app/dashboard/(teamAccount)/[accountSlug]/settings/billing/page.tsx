'use client';

import React from 'react';
import {createClient} from "@/lib/supabase/server";
import AccountBillingStatus from "@/components/basejump/account-billing-status";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";

const returnUrl = process.env.NEXT_PUBLIC_URL as string;

type AccountParams = {
  accountSlug: string;
};

export default function TeamBillingPage({ params }: { params: Promise<AccountParams> }) {
    const unwrappedParams = React.use(params);
    const { accountSlug } = unwrappedParams;
    
    // Use an effect to load team account data
    const [teamAccount, setTeamAccount] = React.useState<any>(null);
    const [error, setError] = React.useState<string | null>(null);
    
    React.useEffect(() => {
        async function loadData() {
            try {
                const supabaseClient = await createClient();
                const {data} = await supabaseClient.rpc('get_account_by_slug', {
                    slug: accountSlug
                });
                setTeamAccount(data);
            } catch (err) {
                setError("Failed to load account data");
                console.error(err);
            }
        }
        
        loadData();
    }, [accountSlug]);
    
    if (error) {
        return (
            <Alert variant="destructive" className="border-red-300 dark:border-red-800 rounded-xl">
                <AlertTitle>Error</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
            </Alert>
        );
    }
    
    if (!teamAccount) {
        return <div>Loading...</div>;
    }

    if (teamAccount.account_role !== 'owner') {
        return (
            <Alert variant="destructive" className="border-red-300 dark:border-red-800 rounded-xl">
                <AlertTitle>Access Denied</AlertTitle>
                <AlertDescription>You do not have permission to access this page.</AlertDescription>
            </Alert>
        )
    }

    return (
        <div className="space-y-6">
            <div>
                <h3 className="text-lg font-medium text-card-title">Team Billing</h3>
                <p className="text-sm text-foreground/70">
                    Manage your team's subscription and billing details.
                </p>
            </div>
            
            <AccountBillingStatus 
                accountId={teamAccount.account_id} 
                returnUrl={`${returnUrl}/dashboard/${accountSlug}/settings/billing`} 
            />
        </div>
    )
}