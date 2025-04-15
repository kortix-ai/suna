import EditTeamName from "@/components/basejump/edit-team-name";
import EditTeamSlug from "@/components/basejump/edit-team-slug";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default async function TeamSettingsPage({ params: { accountSlug } }: { params: { accountSlug: string } }) {
    const supabaseClient = await createClient();
    const { data: teamAccount } = await supabaseClient.rpc('get_account_by_slug', {
        slug: accountSlug
    });

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
                    <CardDescription>
                        Update your team name.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <EditTeamName account={teamAccount} />
                </CardContent>
            </Card>
            
            <Card className="border-subtle dark:border-white/10 bg-white dark:bg-background-secondary shadow-none">
                <CardHeader>
                    <CardTitle className="text-base text-card-title">Team URL</CardTitle>
                    <CardDescription>
                        Update your team URL slug.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <EditTeamSlug account={teamAccount} />
                </CardContent>
            </Card>
        </div>
    )
}