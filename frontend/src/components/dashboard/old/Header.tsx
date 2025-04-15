"use client";
import Link from "next/link";
import { useState } from "react";
import { signOut } from "@/app/auth/actions";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { 
  Sun, 
  Moon, 
  UserIcon,
  Laptop
} from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuGroup,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";

interface HeaderProps {
  userName?: string;
  userEmail?: string;
  showRightSidebar: boolean;
  effectiveRightPanelContent: React.ReactNode;
  effectiveRightPanelTitle: string;
  showPanel: boolean;
  toggleRightSidebarVisibility: () => void;
}

export default function Header({
  userName,
  userEmail,
  showRightSidebar,
  effectiveRightPanelContent,
  effectiveRightPanelTitle,
  showPanel,
  toggleRightSidebarVisibility
}: HeaderProps) {
  const { theme, setTheme } = useTheme();
  const router = useRouter();
  
  const handleSignOut = async () => {
    await signOut();
    router.refresh();
  };

  return (
    <header className="h-12 px-4 flex items-center justify-end">
      <div className="flex items-center gap-3">
        {!showRightSidebar && effectiveRightPanelContent && (
          <button
            onClick={toggleRightSidebarVisibility}
            className="px-3 py-1.5 rounded-full hover:bg-hover-bg text-foreground/80 hover:text-foreground transition-all duration-200 text-xs border border-subtle dark:border-white/10"
          >
            {showPanel ? (
              <span className="flex items-center gap-1">
                <Laptop className="h-3 w-3" />
                {`Suna's Computer`}
              </span>
            ) : (
              effectiveRightPanelTitle
            )}
          </button>
        )}
        
        {/* User dropdown in header - always show */}
        <div className="flex-shrink-0">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="relative h-8 w-8 rounded-full border border-subtle dark:border-white/10 hover:bg-hover-bg flex items-center justify-center">
                <UserIcon className="h-4 w-4 text-foreground/80" />
                <span className="sr-only">User menu</span>
              </button>
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
                <DropdownMenuItem asChild className="rounded-md hover:!bg-[#f1eee7] dark:hover:!bg-[#141413] cursor-pointer">
                  <Link href="/dashboard" className="flex w-full h-full text-foreground/90">My Account</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild className="rounded-md hover:!bg-[#f1eee7] dark:hover:!bg-[#141413] cursor-pointer">
                  <Link href="/dashboard/settings" className="flex w-full h-full text-foreground/90">Settings</Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild className="rounded-md hover:!bg-[#f1eee7] dark:hover:!bg-[#141413] cursor-pointer">
                  <Link href="/dashboard/settings/teams" className="flex w-full h-full text-foreground/90">Teams</Link>
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator className="border-subtle dark:border-white/10" />
              <div className="p-1">
                <DropdownMenuItem asChild className="rounded-md hover:!bg-[#f1eee7] dark:hover:!bg-[#141413] cursor-pointer">
                  <button onClick={handleSignOut} className="flex w-full h-full px-2 py-1.5 text-left text-foreground/90">Log out</button>
                </DropdownMenuItem>
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        
        <div className="relative">
          <button
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            className="relative h-8 w-8 rounded-full border border-subtle dark:border-white/10 hover:bg-hover-bg flex items-center justify-center"
          >
            <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
            <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" />
            <span className="sr-only">Toggle theme</span>
          </button>
        </div>
      </div>
    </header>
  );
} 