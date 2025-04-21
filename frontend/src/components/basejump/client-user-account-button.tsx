'use client';

import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import Link from "next/link";
import { UserIcon } from "lucide-react";
import { signOut } from "@/app/auth/actions";
import { useRouter } from "next/navigation";

interface ClientUserAccountButtonProps {
    userName?: string;
    userEmail?: string;
}

export default function ClientUserAccountButton({ 
    userName = "Account", 
    userEmail = "" 
}: ClientUserAccountButtonProps) {
    const router = useRouter();

    const handleSignOut = async () => {
        await signOut();
        router.refresh();
    };
    
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button 
                    variant="ghost" 
                    className="h-9 w-9 rounded-full border border-subtle dark:border-white/10 hover:bg-hover-bg p-0"
                >
                    <UserIcon className="h-[1.2rem] w-[1.2rem] text-foreground/80" />
                    <span className="sr-only">User menu</span>
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56 border-subtle dark:border-white/10 bg-card-bg dark:bg-background-secondary rounded-xl shadow-custom" align="end" forceMount>
                <DropdownMenuLabel className="font-normal border-b border-subtle dark:border-white/10">
                    <div className="flex flex-col space-y-1">
                        <p className="text-sm font-medium leading-none text-foreground">{userName}</p>
                        {userEmail && (
                            <p className="text-xs leading-none text-foreground/70">
                                {userEmail}
                            </p>
                        )}
                    </div>
                </DropdownMenuLabel>
                <DropdownMenuGroup className="p-1">
                    <DropdownMenuItem asChild className="rounded-md hover:bg-hover-bg cursor-pointer">
                        <Link href="/dashboard" className="flex w-full h-full text-foreground/90">My Account</Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild className="rounded-md hover:bg-hover-bg cursor-pointer">
                        <Link href="/settings" className="flex w-full h-full text-foreground/90">Settings</Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild className="rounded-md hover:bg-hover-bg cursor-pointer">
                        <Link href="/settings/teams" className="flex w-full h-full text-foreground/90">Teams</Link>
                    </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator className="border-subtle dark:border-white/10" />
                <div className="p-1">
                    <DropdownMenuItem asChild className="rounded-md hover:bg-hover-bg text-foreground/90 cursor-pointer">
                        <button onClick={handleSignOut} className="flex w-full h-full px-2 py-1.5 text-left">
                            Log out
                        </button>
                    </DropdownMenuItem>
                </div>
            </DropdownMenuContent>
        </DropdownMenu>
    );
} 