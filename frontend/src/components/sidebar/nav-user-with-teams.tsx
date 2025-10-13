'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  BadgeCheck,
  Bell,
  ChevronDown,
  ChevronsUpDown,
  ChevronRight,
  Command,
  CreditCard,
  Key,
  LogOut,
  Plus,
  Settings,
  User,
  AudioWaveform,
  Sun,
  Moon,
  KeyRound,
  Plug,
  Zap,
  Shield,
  DollarSign,
  Users,
  BarChart3,
  FileText,
} from 'lucide-react';
import { useAccounts } from '@/hooks/use-accounts';
import NewTeamForm from '@/components/basejump/new-team-form';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuPortal,
} from '@/components/ui/dropdown-menu';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { createClient } from '@/lib/supabase/client';
import { useTheme } from 'next-themes';
import { isLocalMode } from '@/lib/config';
import { clearUserLocalStorage } from '@/lib/utils/clear-local-storage';
import { BillingModal } from '@/components/billing/billing-modal';

export function NavUserWithTeams({
  user,
}: {
  user: {
    name: string;
    email: string;
    avatar: string;
    isAdmin?: boolean;
    planName?: string;
    planIcon?: string;
  };
}) {
  const router = useRouter();
  const { isMobile } = useSidebar();
  const { data: accounts } = useAccounts();
  const [showNewTeamDialog, setShowNewTeamDialog] = React.useState(false);
  const [showBillingModal, setShowBillingModal] = React.useState(false);
  const { theme, setTheme } = useTheme();

  // Prepare personal account and team accounts
  const personalAccount = React.useMemo(
    () => accounts?.find((account) => account.personal_account),
    [accounts],
  );
  const teamAccounts = React.useMemo(
    () => accounts?.filter((account) => !account.personal_account),
    [accounts],
  );

  // Create a default list of teams with logos for the UI (will show until real data loads)
  const defaultTeams = [
    {
      name: personalAccount?.name || 'Personal Account',
      logo: Command,
      plan: 'Personal',
      account_id: personalAccount?.account_id,
      slug: personalAccount?.slug,
      personal_account: true,
    },
    ...(teamAccounts?.map((team) => ({
      name: team.name,
      logo: AudioWaveform,
      plan: 'Team',
      account_id: team.account_id,
      slug: team.slug,
      personal_account: false,
    })) || []),
  ];

  // Use the first team or first entry in defaultTeams as activeTeam
  const [activeTeam, setActiveTeam] = React.useState(defaultTeams[0]);

  // Update active team when accounts load
  React.useEffect(() => {
    if (accounts?.length) {
      const currentTeam = accounts.find(
        (account) => account.account_id === activeTeam.account_id,
      );
      if (currentTeam) {
        setActiveTeam({
          name: currentTeam.name,
          logo: currentTeam.personal_account ? Command : AudioWaveform,
          plan: currentTeam.personal_account ? 'Personal' : 'Team',
          account_id: currentTeam.account_id,
          slug: currentTeam.slug,
          personal_account: currentTeam.personal_account,
        });
      } else {
        // If current team not found, set first available account as active
        const firstAccount = accounts[0];
        setActiveTeam({
          name: firstAccount.name,
          logo: firstAccount.personal_account ? Command : AudioWaveform,
          plan: firstAccount.personal_account ? 'Personal' : 'Team',
          account_id: firstAccount.account_id,
          slug: firstAccount.slug,
          personal_account: firstAccount.personal_account,
        });
      }
    }
  }, [accounts, activeTeam.account_id]);

  // Handle team selection
  const handleTeamSelect = (team) => {
    setActiveTeam(team);

    // Navigate to the appropriate dashboard
    if (team.personal_account) {
      router.push('/dashboard');
    } else {
      router.push(`/${team.slug}`);
    }
  };

  const handleLogout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    // Clear local storage after sign out
    clearUserLocalStorage();
    router.push('/auth');
  };

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((part) => part.charAt(0))
      .join('')
      .toUpperCase()
      .substring(0, 2);
  };

  if (!activeTeam) {
    return null;
  }

  return (
    <Dialog open={showNewTeamDialog} onOpenChange={setShowNewTeamDialog}>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                size="lg"
                className="bg-transparent hover:bg-transparent data-[state=open]:bg-transparent border-[1.5px] border-border h-[64px] p-3"
              >
                <Avatar className="h-10 w-10 rounded-full flex-shrink-0">
                  <AvatarImage src={user.avatar} alt={user.name} />
                  <AvatarFallback className="rounded-full">
                    {getInitials(user.name)}
                  </AvatarFallback>
                </Avatar>
                <div className="flex flex-col justify-center flex-1 min-w-0 py-2">
                  <span className="truncate font-medium text-base">{user.name}</span>
                  {user.planName && user.planIcon ? (
                    <div className="flex items-center mt-1">
                      <>
                        <div className="bg-black dark:hidden rounded-full px-2 py-1 flex items-center justify-center w-fit">
                          <img
                            src={user.planIcon}
                            alt={user.planName}
                            className="flex-shrink-0 h-[12px] w-auto"
                          />
                        </div>
                        <img
                          src={user.planIcon}
                          alt={user.planName}
                          className="flex-shrink-0 h-[12px] w-auto hidden dark:block"
                        />
                      </>
                    </div>
                  ) : (
                    <span className="truncate text-sm text-muted-foreground mt-1">{user.email}</span>
                  )}
                </div>
                <ChevronsUpDown className="ml-auto size-4 flex-shrink-0" />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="w-(--radix-dropdown-menu-trigger-width) min-w-56 p-2"
              side={isMobile ? 'bottom' : 'top'}
              align="start"
              sideOffset={4}
            >
              {/* Teams Section */}
              {personalAccount && (
                <>
                  <DropdownMenuLabel className="text-muted-foreground text-xs px-2 py-1.5">
                    Workspaces
                  </DropdownMenuLabel>
                  <DropdownMenuItem
                    key={personalAccount.account_id}
                    onClick={() =>
                      handleTeamSelect({
                        name: personalAccount.name,
                        logo: Command,
                        plan: 'Personal',
                        account_id: personalAccount.account_id,
                        slug: personalAccount.slug,
                        personal_account: true,
                      })
                    }
                    className="gap-2 p-2"
                  >
                    <div className="flex size-6 items-center justify-center rounded-xs border">
                      <Command className="size-4 shrink-0" />
                    </div>
                    <span className="flex-1">{personalAccount.name}</span>
                    {activeTeam.account_id === personalAccount.account_id && (
                      <div className="size-4 flex items-center justify-center">
                        <div className="size-1.5 rounded-full bg-primary" />
                      </div>
                    )}
                  </DropdownMenuItem>
                </>
              )}

              {teamAccounts?.length > 0 && (
                <>
                  {teamAccounts.map((team, index) => (
                    <DropdownMenuItem
                      key={team.account_id}
                      onClick={() =>
                        handleTeamSelect({
                          name: team.name,
                          logo: AudioWaveform,
                          plan: 'Team',
                          account_id: team.account_id,
                          slug: team.slug,
                          personal_account: false,
                        })
                      }
                      className="gap-2 p-2"
                    >
                      <div className="flex size-6 items-center justify-center rounded-xs border">
                        <AudioWaveform className="size-4 shrink-0" />
                      </div>
                      <span className="flex-1">{team.name}</span>
                      {activeTeam.account_id === team.account_id && (
                        <div className="size-4 flex items-center justify-center">
                          <div className="size-1.5 rounded-full bg-primary" />
                        </div>
                      )}
                    </DropdownMenuItem>
                  ))}
                </>
              )}

              {/* <DropdownMenuSeparator />
              <DialogTrigger asChild>
                <DropdownMenuItem 
                  className="gap-2 p-2"
                  onClick={() => {
                    setShowNewTeamDialog(true)
                  }}
                >
                  <div className="bg-background flex size-6 items-center justify-center rounded-md border">
                    <Plus className="size-4" />
                  </div>
                  <div className="text-muted-foreground font-medium">Add team</div>
                </DropdownMenuItem>
              </DialogTrigger> */}
              <DropdownMenuSeparator className="my-1" />

              {/* General Section */}
              <DropdownMenuLabel className="text-muted-foreground text-xs px-2 py-1.5">
                General
              </DropdownMenuLabel>
              <DropdownMenuGroup>
                {user.planName && (
                  <DropdownMenuItem onClick={() => setShowBillingModal(true)} className="gap-2 p-2">
                    <Zap className="h-4 w-4" />
                    <span>Upgrade Plan</span>
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem asChild>
                  <Link href="/settings/billing" className="gap-2 p-2">
                    <CreditCard className="h-4 w-4" />
                    <span>Billing</span>
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/settings/credentials" className="gap-2 p-2">
                    <Plug className="h-4 w-4" />
                    <span>Integrations</span>
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/settings" className="gap-2 p-2">
                    <Settings className="h-4 w-4" />
                    <span>Settings</span>
                  </Link>
                </DropdownMenuItem>
              </DropdownMenuGroup>

              {(user.isAdmin || isLocalMode()) && (
                <>
                  <DropdownMenuSeparator className="my-1" />
                  <DropdownMenuLabel className="text-muted-foreground text-xs px-2 py-1.5">
                    Advanced
                  </DropdownMenuLabel>
                  <DropdownMenuGroup>
                    {user.isAdmin && (
                      <DropdownMenuItem asChild>
                        <Link href="/admin/billing" className="gap-2 p-2">
                          <Shield className="h-4 w-4" />
                          <span>Admin Panel</span>
                        </Link>
                      </DropdownMenuItem>
                    )}
                    {user.isAdmin && (
                      <DropdownMenuItem asChild>
                        <Link href="/settings/api-keys" className="gap-2 p-2">
                          <Key className="h-4 w-4" />
                          <span>API Keys</span>
                        </Link>
                      </DropdownMenuItem>
                    )}
                    {isLocalMode() && (
                      <DropdownMenuItem asChild>
                        <Link href="/settings/env-manager" className="gap-2 p-2">
                          <KeyRound className="h-4 w-4" />
                          <span>Local .Env Manager</span>
                        </Link>
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuGroup>
                </>
              )}

              <DropdownMenuSeparator className="my-1" />
              <DropdownMenuItem onClick={handleLogout} className="gap-2 p-2">
                <LogOut className="h-4 w-4" />
                <span>Log Out</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>

      <DialogContent className="sm:max-w-[425px] border-subtle dark:border-white/10 bg-card-bg dark:bg-background-secondary rounded-2xl shadow-custom">
        <DialogHeader>
          <DialogTitle className="text-foreground">
            Create a new team
          </DialogTitle>
          <DialogDescription className="text-foreground/70">
            Create a team to collaborate with others.
          </DialogDescription>
        </DialogHeader>
        <NewTeamForm />
      </DialogContent>

      {/* Billing Modal */}
      <BillingModal
        open={showBillingModal}
        onOpenChange={setShowBillingModal}
        returnUrl={typeof window !== 'undefined' ? window?.location?.href || '/' : '/'}
      />
    </Dialog>
  );
}
