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
  TrendingDown,
} from 'lucide-react';
import { useAccounts } from '@/hooks/account';
import { useAccountState } from '@/hooks/billing';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
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
import { UserSettingsModal } from '@/components/settings/user-settings-modal';
import { PlanSelectionModal } from '@/components/billing/pricing';
import { TierBadge } from '@/components/billing/tier-badge';
import { useTranslations } from 'next-intl';

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
  const t = useTranslations('sidebar');
  const router = useRouter();
  const { isMobile } = useSidebar();
  const { data: accounts } = useAccounts();
  const { data: accountState } = useAccountState({ enabled: true });
  const [showNewTeamDialog, setShowNewTeamDialog] = React.useState(false);
  const [showSettingsModal, setShowSettingsModal] = React.useState(false);
  const [showPlanModal, setShowPlanModal] = React.useState(false);
  const [settingsTab, setSettingsTab] = React.useState<'general' | 'billing' | 'usage' | 'env-manager'>('general');
  const { theme, setTheme } = useTheme();

  // Check if user is on free tier
  const isFreeTier = accountState?.subscription?.tier_key === 'free' ||
    accountState?.tier?.name === 'free' ||
    !accountState?.subscription?.tier_key;

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
        <SidebarMenuItem className="relative">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                size="lg"
                className="bg-transparent hover:bg-transparent data-[state=open]:bg-transparent border-[1.5px] border-border h-[64px] p-3 group-data-[collapsible=icon]:!p-0 group-data-[collapsible=icon]:!h-10 group-data-[collapsible=icon]:!w-10 group-data-[collapsible=icon]:border-0"
              >
                <Avatar className="h-10 w-10 rounded-full flex-shrink-0">
                  <AvatarImage src={user.avatar} alt={user.name} />
                  <AvatarFallback className="rounded-full">
                    {getInitials(user.name)}
                  </AvatarFallback>
                </Avatar>
                <div className="flex flex-col justify-between flex-1 min-w-0 h-10 group-data-[collapsible=icon]:hidden">
                  <span className="truncate font-medium text-sm leading-tight">{user.name}</span>
                  {user.planName ? (
                    <TierBadge planName={user.planName} size="xs" variant="default" />
                  ) : (
                    <span className="truncate text-xs text-muted-foreground leading-tight">{user.email}</span>
                  )}
                </div>
                <ChevronsUpDown className="ml-auto size-4 flex-shrink-0 group-data-[collapsible=icon]:hidden" />
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
                    {t('workspaces')}
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
                <DropdownMenuItem
                  onClick={() => {
                    setShowPlanModal(true);
                  }}
                  className="gap-2 p-2"
                >
                  <Zap className="h-4 w-4" />
                  <span>Plan</span>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/knowledge" className="gap-2 p-2">
                    <FileText className="h-4 w-4" />
                    <span>Knowledge Base</span>
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    setSettingsTab('billing');
                    setShowSettingsModal(true);
                  }}
                  className="gap-2 p-2"
                >
                  <CreditCard className="h-4 w-4" />
                  <span>Billing</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    setSettingsTab('usage');
                    setShowSettingsModal(true);
                  }}
                  className="gap-2 p-2"
                >
                  <TrendingDown className="h-4 w-4" />
                  <span>Usage</span>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/settings/credentials" className="gap-2 p-2">
                    <Plug className="h-4 w-4" />
                    <span>Integrations</span>
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    setSettingsTab('general');
                    setShowSettingsModal(true);
                  }}
                  className="gap-2 p-2"
                >
                  <Settings className="h-4 w-4" />
                  <span>Settings</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
                  className="gap-2 p-2"
                >
                  <div className="relative h-4 w-4">
                    <Sun className="h-4 w-4 absolute rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
                    <Moon className="h-4 w-4 absolute rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
                  </div>
                  <span>{t('theme')}</span>
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
                      <DropdownMenuItem
                        onClick={() => {
                          setSettingsTab('env-manager');
                          setShowSettingsModal(true);
                        }}
                        className="gap-2 p-2"
                      >
                        <KeyRound className="h-4 w-4" />
                        <span>Local .Env Manager</span>
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuGroup>
                </>
              )}

              <DropdownMenuSeparator className="my-1" />
              <DropdownMenuItem onClick={handleLogout} className="gap-2 p-2">
                <LogOut className="h-4 w-4" />
                <span>{t('logout')}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Upgrade Button - Only for Free Tier */}
          {isFreeTier && (
            <div className="absolute bottom-full left-0 right-0 mb-2 px-0 group-data-[collapsible=icon]:hidden z-50">
              <Button
                onClick={() => setShowPlanModal(true)}
                variant="default"
                size="lg"
                className="w-full relative z-50"
              >
                Upgrade
              </Button>
            </div>
          )}
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
        {/* Team form removed - basejump functionality deprecated */}
      </DialogContent>

      {/* User Settings Modal */}
      <UserSettingsModal
        open={showSettingsModal}
        onOpenChange={setShowSettingsModal}
        defaultTab={settingsTab}
        returnUrl={typeof window !== 'undefined' ? window?.location?.href || '/' : '/'}
      />

      {/* Plan Selection Modal */}
      <PlanSelectionModal
        open={showPlanModal}
        onOpenChange={setShowPlanModal}
        returnUrl={typeof window !== 'undefined' ? window?.location?.href || '/' : '/'}
      />
    </Dialog>
  );
}
