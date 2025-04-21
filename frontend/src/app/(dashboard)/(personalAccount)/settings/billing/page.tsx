import {createClient} from "@/lib/supabase/server";
import AccountBillingStatus from "@/components/basejump/account-billing-status";

const returnUrl = process.env.NEXT_PUBLIC_URL as string;

export default async function PersonalAccountBillingPage() {
    const supabaseClient = await createClient();
    const {data: personalAccount} = await supabaseClient.rpc('get_personal_account');


    return (
        <div>
            <AccountBillingStatus accountId={personalAccount.account_id} returnUrl={`${returnUrl}/settings/billing`} />
        </div>
    )
}