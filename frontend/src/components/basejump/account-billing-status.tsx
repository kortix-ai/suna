import { createClient } from "@/lib/supabase/server";
import { SubmitButton } from "../ui/submit-button";
import { manageSubscription } from "@/lib/actions/billing";
import { PlanComparison, SUBSCRIPTION_PLANS } from "../billing/PlanComparison";

type Props = {
    accountId: string;
    returnUrl: string;
}

export default async function AccountBillingStatus({ accountId, returnUrl }: Props) {
    const supabaseClient = await createClient();

    const { data: billingData, error: billingError } = await supabaseClient.functions.invoke('billing-functions', {
        body: {
            action: "get_billing_status",
            args: {
                account_id: accountId
            }
        }
    });

    // Get current subscription details
    const { data: subscriptionData } = await supabaseClient
        .schema('basejump')
        .from('billing_subscriptions')
        .select('price_id')
        .eq('account_id', accountId)
        .eq('status', 'active')
        .single();

    const currentPlanId = subscriptionData?.price_id;

    // Get agent run hours for current month
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    // First get threads for this account
    const { data: threadsData } = await supabaseClient
        .from('threads')
        .select('thread_id')
        .eq('account_id', accountId);

    const threadIds = threadsData?.map(t => t.thread_id) || [];

    // Then get agent runs for those threads
    const { data: agentRunData, error: agentRunError } = await supabaseClient
        .from('agent_runs')
        .select('started_at, completed_at')
        .in('thread_id', threadIds)
        .gte('started_at', startOfMonth.toISOString());

    let totalSeconds = 0;
    if (agentRunData) {
        totalSeconds = agentRunData.reduce((acc, run) => {
            const start = new Date(run.started_at);
            const end = run.completed_at ? new Date(run.completed_at) : new Date();
            const seconds = (end.getTime() - start.getTime()) / 1000;
            return acc + seconds;
        }, 0);
    }

    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60); 
    const seconds = Math.floor(totalSeconds % 60);
    const usageDisplay = `${hours}h ${minutes}m ${seconds}s`;

    return (
        <div className="space-y-6">
            {!Boolean(billingData?.billing_enabled) ? (
                <div className="rounded-xl bg-destructive/10 border border-destructive p-6">
                    <h3 className="text-lg font-medium text-destructive mb-2">Billing Not Enabled</h3>
                    <p className="text-sm text-destructive/80">
                        Billing is not enabled for this account. Check out usebasejump.com for more info or remove this component if you don't plan on enabling billing.
                    </p>
                </div>
            ) : (
                <>
                    <div className="rounded-xl bg-[#F3F4F6] dark:bg-[#F9FAFB]/[0.02] border border-border p-6">
                        <div className="flex flex-col gap-4">
                            <div className="flex justify-between items-center">
                                <span className="text-sm font-medium text-foreground/90">Status</span>
                                <span className="text-sm font-medium text-card-title">
                                    {(!currentPlanId || currentPlanId === SUBSCRIPTION_PLANS.FREE) ? 'Active (Free)' : billingData.status === 'active' ? 'Active' : 'Inactive'}
                                </span>
                            </div>
                            {billingData.plan_name && (
                                <div className="flex justify-between items-center">
                                    <span className="text-sm font-medium text-foreground/90">Plan</span>
                                    <span className="text-sm font-medium text-card-title">{billingData.plan_name}</span>
                                </div>
                            )}
                            <div className="flex justify-between items-center">
                                <span className="text-sm font-medium text-foreground/90">Agent Usage This Month</span>
                                <span className="text-sm font-medium text-card-title">{usageDisplay}</span>
                            </div>
                        </div>
                    </div>

                    {/* Plans Comparison */}
                    <PlanComparison
                        accountId={accountId}
                        returnUrl={returnUrl}
                        className="mb-6"
                    />

                    {/* Manage Subscription Button */}
                    <form>
                        <input type="hidden" name="accountId" value={accountId} />
                        <input type="hidden" name="returnUrl" value={returnUrl} />
                        <SubmitButton
                            pendingText="Loading..."
                            formAction={manageSubscription}
                            className="w-full bg-primary text-white hover:bg-primary/90 shadow-md hover:shadow-lg transition-all"
                        >
                            Manage Subscription
                        </SubmitButton>
                    </form>
                </>
            )}
        </div>
    )
}
