import {createClient} from "@/lib/supabase/server";
import AccountBillingStatus from "@/components/basejump/account-billing-status";

const returnUrl = process.env.NEXT_PUBLIC_URL as string;

export default async function PersonalAccountBillingPage() {
    const supabaseClient = await createClient();
    const {data: personalAccount} = await supabaseClient.rpc('get_personal_account');

    return (
        <div className="space-y-8">
            <div className="space-y-2">
                <h3 className="text-2xl font-medium tracking-tight">Billing</h3>
                <p className="text-muted-foreground">
                    Manage your subscription and billing details.
                </p>
            </div>
            
            <AccountBillingStatus 
                accountId={personalAccount.account_id} 
                returnUrl={`${returnUrl}/dashboard/settings/billing`} 
            />
        </div>
    )
}