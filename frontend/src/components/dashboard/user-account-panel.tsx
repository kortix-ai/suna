'use client';

import { useRouter } from "next/navigation";
import AccountSelector from "@/components/basejump/account-selector";

interface UserAccountPanelProps {
    accountId: string;
    userName?: string;
    userEmail?: string;
    isCollapsed?: boolean;
}

export default function UserAccountPanel({ 
    accountId, 
    userName = "Account", 
    userEmail = "",
    isCollapsed = false
}: UserAccountPanelProps) {
    const router = useRouter();

    if (isCollapsed) {
        return (
            <div className="flex flex-col items-center space-y-2">
                <div className="w-12 h-12 shadow-custom border border-subtle dark:border-white/10 bg-card-bg dark:bg-background-secondary rounded-2xl overflow-hidden flex items-center justify-center">
                    <AccountSelector
                        accountId={accountId}
                        onAccountSelected={(account) => router.push(account?.personal_account ? `/dashboard` : `/dashboard/${account?.slug}`)}
                        className="w-10 h-10 rounded-full border-0 justify-center !p-0"
                    />
                </div>
                
                {/* Other UI elements for collapsed mode can remain but we'll keep it minimal */}
                <div className="hidden">
                    {/* User dropdown removed from here */}
                </div>
            </div>
        );
    }

    return (
        <div className="py-3">
            {/* Only Account Selector */}
            <AccountSelector
                accountId={accountId}
                onAccountSelected={(account) => router.push(account?.personal_account ? `/dashboard` : `/dashboard/${account?.slug}`)}
            />

            {/* User dropdown removed */}
        </div>
    );
} 