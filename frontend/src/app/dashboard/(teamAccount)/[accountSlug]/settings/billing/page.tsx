import {createClient} from "@/lib/supabase/server";
import AccountBillingStatus from "@/components/basejump/account-billing-status";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";

const returnUrl = process.env.NEXT_PUBLIC_URL as string;

export default async function TeamBillingPage({params: {accountSlug}}: {params: {accountSlug: string}}) {
    const supabaseClient = await createClient();
    const {data: teamAccount} = await supabaseClient.rpc('get_account_by_slug', {
        slug: accountSlug
    });

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