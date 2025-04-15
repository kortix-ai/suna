import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../ui/card";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
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

    const { data: agentRunData, error: agentRunError } = await supabaseClient
        .from('agent_runs')
        .select('started_at, completed_at')
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
        <Card className="border-subtle dark:border-white/10 bg-white dark:bg-background-secondary shadow-none rounded-xl">
            <CardHeader className="pb-3">
                <CardTitle className="text-base text-card-title">Subscription Status</CardTitle>
                <CardDescription className="text-foreground/70">
                    Manage your subscription and payment details
                </CardDescription>
            </CardHeader>
            <CardContent>
                {!Boolean(billingData?.billing_enabled) ? (
                    <Alert variant="destructive" className="border-red-300 dark:border-red-800 rounded-xl">
                        <AlertTitle>Billing Not Enabled</AlertTitle>
                        <AlertDescription>
                            Billing is not enabled for this account. Check out usebasejump.com for more info or remove this component if you don't plan on enabling billing.
                        </AlertDescription>
                    </Alert>
                ) : (
                    <>
                        <div className="p-4 border border-subtle dark:border-white/10 rounded-lg bg-card-bg dark:bg-background-secondary mb-6">
                            <div className="flex flex-col gap-2">
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
                                className="w-full"
                                variant="outline"
                            >
                                Manage Subscription
                            </SubmitButton>
                        </form>
                    </>
                )}
            </CardContent>
        </Card>
    )
}
