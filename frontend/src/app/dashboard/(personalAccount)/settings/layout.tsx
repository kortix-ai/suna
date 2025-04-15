import SettingsNavigation from "@/components/dashboard/settings-navigation";
import {Separator} from "@/components/ui/separator";

export default function PersonalAccountSettingsPage({children}: {children: React.ReactNode}) {
    const items = [
        { name: "Profile", href: "/dashboard/settings" },
        { name: "Teams", href: "/dashboard/settings/teams" },
        { name: "Billing", href: "/dashboard/settings/billing" },
    ]
    return (
        <div className="space-y-6 w-full">
            <Separator className="border-subtle dark:border-white/10" />
            <div className="flex flex-col space-y-8 lg:flex-row lg:space-x-12 lg:space-y-0 w-full max-w-6xl mx-auto px-4">
                <aside className="lg:w-1/4 p-1">
                    <SettingsNavigation items={items} />
                </aside>
                <div className="flex-1 bg-card-bg dark:bg-background-secondary p-6 rounded-2xl border border-subtle dark:border-white/10 shadow-custom">
                    {children}
                </div>
            </div>
        </div>
    )
}