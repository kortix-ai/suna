'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Bell,
  ChevronRight,
  ChevronsUpDown,
  Command,
  CreditCard,
  Key,
  LogOut,
  Settings,
  AudioWaveform,
  Sun,
  Moon,
  KeyRound,
  Plug,
  Zap,
  Shield,
  BarChart3,
  FileText,
  TrendingDown,
  MessageSquare,
  Heart,
  LifeBuoy,
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
  DropdownMenuTrigger,
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
} from '@/components/ui/dialog';
import { createClient } from '@/lib/supabase/client';
import { useTheme } from 'next-themes';
import { isLocalMode, isProductionMode } from '@/lib/config';
import { clearUserLocalStorage } from '@/lib/utils/clear-local-storage';
import { UserSettingsModal } from '@/components/settings/user-settings-modal';
import { PlanSelectionModal } from '@/components/billing/pricing';
import { TierBadge } from '@/components/billing/tier-badge';
import { useTranslations } from 'next-intl';
import { useReferralDialog } from '@/stores/referral-dialog';
import { ReferralDialog } from '@/components/referrals/referral-dialog';
import { cn } from '@/lib/utils';

export function UserMenu({
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
  const { isMobile, state } = useSidebar();
  const { data: accounts } = useAccounts();
  const { data: accountState } = useAccountState({ enabled: true });
  const [showNewTeamDialog, setShowNewTeamDialog] = React.useState(false);
  const [showSettingsModal, setShowSettingsModal] = React.useState(false);
  const [showPlanModal, setShowPlanModal] = React.useState(false);
  const [settingsTab, setSettingsTab] = React.useState<'general' | 'billing' | 'usage' | 'env-manager'>('general');
  const { isOpen: isReferralDialogOpen, openDialog: openReferralDialog, closeDialog: closeReferralDialog } = useReferralDialog();
  const { theme, setTheme } = useTheme();

  const isFreeTier = accountState?.subscription?.tier_key === 'free' ||
    accountState?.tier?.name === 'free' ||
    !accountState?.subscription?.tier_key;

  const personalAccount = React.useMemo(
    () => accounts?.find((account) => account.personal_account),
    [accounts],
  );
  const teamAccounts = React.useMemo(
    () => accounts?.filter((account) => !account.personal_account),
    [accounts],
  );

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

  const [activeTeam, setActiveTeam] = React.useState(defaultTeams[0]);

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

  const handleTeamSelect = (team: typeof activeTeam) => {
    setActiveTeam(team);
    if (team.personal_account) {
      router.push('/dashboard');
    } else {
      router.push(`/${team.slug}`);
    }
  };

  const handleLogout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
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

  const isCollapsed = state === 'collapsed';

  return (
    <Dialog open={showNewTeamDialog} onOpenChange={setShowNewTeamDialog}>
      <SidebarMenu>
        <SidebarMenuItem className="relative">
          {/* Upgrade & Referral buttons above user card */}
          {!isCollapsed && (
            <div className="mb-3 space-y-2">
              {/* Referral Card */}
              {!isProductionMode() && (
                <button
                  onClick={openReferralDialog}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl bg-foreground/[0.04] hover:bg-foreground/[0.06] transition-colors text-left group"
                >
                  <Heart className="h-4 w-4 text-rose-500 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-foreground">{t('referralShareTitle')}</div>
                    <div className="text-xs text-muted-foreground truncate">{t('referralShareSubtitle')}</div>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground/50 group-hover:text-muted-foreground transition-colors flex-shrink-0" />
                </button>
              )}
              
              {/* Upgrade Button */}
              {isFreeTier && (
                <Button
                  onClick={() => setShowPlanModal(true)}
                  className="w-full h-10 rounded-xl font-medium"
                >
                  <Zap className="h-4 w-4 mr-2" />
                  {t('upgrade')}
                </Button>
              )}
            </div>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                size="lg"
                className={cn(
                  "rounded-xl transition-all",
                  isCollapsed 
                    ? "h-9 w-9 p-0 justify-center" 
                    : "h-12 px-3 bg-foreground/[0.04] hover:bg-foreground/[0.06]"
                )}
              >
                <Avatar className={cn(
                  "flex-shrink-0 ring-1 ring-border/50",
                  isCollapsed ? "h-7 w-7" : "h-8 w-8"
                )}>
                  <AvatarImage src={user.avatar} alt={user.name} />
                  <AvatarFallback className="text-xs font-medium bg-foreground/[0.06]">
                    {getInitials(user.name)}
                  </AvatarFallback>
                </Avatar>
                
                {!isCollapsed && (
                  <>
                    <div className="flex flex-col flex-1 min-w-0 text-left">
                      <span className="truncate text-sm font-medium leading-tight">{user.name}</span>
                      {user.planName ? (
                        <TierBadge planName={user.planName} size="xs" variant="default" />
                      ) : (
                        <span className="truncate text-xs text-muted-foreground leading-tight">{user.email}</span>
                      )}
                    </div>
                    <ChevronsUpDown className="h-4 w-4 text-muted-foreground/50 flex-shrink-0" />
                  </>
                )}
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            
            <DropdownMenuContent
              className="w-64 p-2 rounded-xl"
              side={isMobile ? 'bottom' : 'top'}
              align="start"
              sideOffset={8}
            >
              {/* Workspaces */}
              {personalAccount && (
                <>
                  <DropdownMenuLabel className="text-muted-foreground text-xs px-2 py-1.5 font-medium">
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
                    className="gap-3 p-2 rounded-lg"
                  >
                    <div className="flex h-6 w-6 items-center justify-center rounded-md bg-foreground/[0.06]">
                      <Command className="h-3.5 w-3.5" />
                    </div>
                    <span className="flex-1 font-medium">{personalAccount.name}</span>
                    {activeTeam.account_id === personalAccount.account_id && (
                      <div className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    )}
                  </DropdownMenuItem>
                </>
              )}

              {teamAccounts && teamAccounts.length > 0 && (
                <>
                  {teamAccounts.map((team) => (
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
                      className="gap-3 p-2 rounded-lg"
                    >
                      <div className="flex h-6 w-6 items-center justify-center rounded-md bg-foreground/[0.06]">
                        <AudioWaveform className="h-3.5 w-3.5" />
                      </div>
                      <span className="flex-1 font-medium">{team.name}</span>
                      {activeTeam.account_id === team.account_id && (
                        <div className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                      )}
                    </DropdownMenuItem>
                  ))}
                </>
              )}

              {(personalAccount || (teamAccounts && teamAccounts.length > 0)) && (
                <DropdownMenuSeparator className="my-2" />
              )}

              {/* General Section */}
              <DropdownMenuLabel className="text-muted-foreground text-xs px-2 py-1.5 font-medium">
                General
              </DropdownMenuLabel>
              <DropdownMenuGroup>
                <DropdownMenuItem
                  onClick={() => setShowPlanModal(true)}
                  className="gap-3 p-2 rounded-lg"
                >
                  <Zap className="h-4 w-4" />
                  <span>Plan</span>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/knowledge" className="gap-3 p-2 rounded-lg">
                    <FileText className="h-4 w-4" />
                    <span>Knowledge Base</span>
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/support" className="gap-3 p-2 rounded-lg">
                    <LifeBuoy className="h-4 w-4" />
                    <span>Support</span>
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    setSettingsTab('billing');
                    setShowSettingsModal(true);
                  }}
                  className="gap-3 p-2 rounded-lg"
                >
                  <CreditCard className="h-4 w-4" />
                  <span>Billing</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    setSettingsTab('usage');
                    setShowSettingsModal(true);
                  }}
                  className="gap-3 p-2 rounded-lg"
                >
                  <TrendingDown className="h-4 w-4" />
                  <span>Usage</span>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/settings/credentials" className="gap-3 p-2 rounded-lg">
                    <Plug className="h-4 w-4" />
                    <span>Integrations</span>
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/settings/api-keys" className="gap-3 p-2 rounded-lg">
                    <Key className="h-4 w-4" />
                    <span>API Keys</span>
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    setSettingsTab('general');
                    setShowSettingsModal(true);
                  }}
                  className="gap-3 p-2 rounded-lg"
                >
                  <Settings className="h-4 w-4" />
                  <span>Settings</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
                  className="gap-3 p-2 rounded-lg"
                >
                  <div className="relative h-4 w-4">
                    <Sun className="h-4 w-4 absolute rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
                    <Moon className="h-4 w-4 absolute rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
                  </div>
                  <span>{t('theme')}</span>
                </DropdownMenuItem>
              </DropdownMenuGroup>

              {/* Admin Section */}
              {(user.isAdmin || isLocalMode()) && (
                <>
                  <DropdownMenuSeparator className="my-2" />
                  <DropdownMenuLabel className="text-muted-foreground text-xs px-2 py-1.5 font-medium">
                    Advanced
                  </DropdownMenuLabel>
                  <DropdownMenuGroup>
                    {user.isAdmin && (
                      <DropdownMenuItem asChild>
                        <Link href="/admin/billing" className="gap-3 p-2 rounded-lg">
                          <Shield className="h-4 w-4" />
                          <span>Admin Panel</span>
                        </Link>
                      </DropdownMenuItem>
                    )}
                    {user.isAdmin && (
                      <DropdownMenuItem asChild>
                        <Link href="/admin/feedback" className="gap-3 p-2 rounded-lg">
                          <MessageSquare className="h-4 w-4" />
                          <span>User Feedback</span>
                        </Link>
                      </DropdownMenuItem>
                    )}
                    {user.isAdmin && (
                      <DropdownMenuItem asChild>
                        <Link href="/admin/analytics" className="gap-3 p-2 rounded-lg">
                          <BarChart3 className="h-4 w-4" />
                          <span>Analytics</span>
                        </Link>
                      </DropdownMenuItem>
                    )}
                    {user.isAdmin && (
                      <DropdownMenuItem asChild>
                        <Link href="/admin/notifications" className="gap-3 p-2 rounded-lg">
                          <Bell className="h-4 w-4" />
                          <span>Notifications</span>
                        </Link>
                      </DropdownMenuItem>
                    )}
                    {isLocalMode() && (
                      <DropdownMenuItem
                        onClick={() => {
                          setSettingsTab('env-manager');
                          setShowSettingsModal(true);
                        }}
                        className="gap-3 p-2 rounded-lg"
                      >
                        <KeyRound className="h-4 w-4" />
                        <span>Local .Env Manager</span>
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuGroup>
                </>
              )}

              <DropdownMenuSeparator className="my-2" />
              <DropdownMenuItem 
                onClick={handleLogout} 
                className="gap-3 p-2 rounded-lg text-destructive focus:text-destructive"
              >
                <LogOut className="h-4 w-4" />
                <span>{t('logout')}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>

      <DialogContent className="sm:max-w-[425px] rounded-2xl">
        <DialogHeader>
          <DialogTitle>Create a new team</DialogTitle>
          <DialogDescription>
            Create a team to collaborate with others.
          </DialogDescription>
        </DialogHeader>
      </DialogContent>

      <UserSettingsModal
        open={showSettingsModal}
        onOpenChange={setShowSettingsModal}
        defaultTab={settingsTab}
        returnUrl={typeof window !== 'undefined' ? window?.location?.href || '/' : '/'}
      />

      <PlanSelectionModal
        open={showPlanModal}
        onOpenChange={setShowPlanModal}
        returnUrl={typeof window !== 'undefined' ? window?.location?.href || '/' : '/'}
      />
      
      <ReferralDialog
        open={isReferralDialogOpen}
        onOpenChange={closeReferralDialog}
      />
    </Dialog>
  );
}

// Legacy export for backward compatibility
export const NavUserWithTeams = UserMenu;

