'use client';

import * as React from 'react';
import Link from 'next/link';
import { Bot, Menu, Plus, Zap, ChevronRight, BookOpen, Code, Star, Package, Sparkle, Sparkles, X, MessageCircle, PanelLeftOpen, Settings, LogOut, User, CreditCard, Key, Plug, Shield, DollarSign, KeyRound, Sun, Moon, Book, Database, PanelLeftClose } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

import { NavAgents } from '@/components/sidebar/nav-agents';
import { NavAgentsView } from '@/components/sidebar/nav-agents-view';
import { NavGlobalConfig } from '@/components/sidebar/nav-global-config';
import { NavTriggerRuns } from '@/components/sidebar/nav-trigger-runs';
import { NavUserWithTeams } from '@/components/sidebar/nav-user-with-teams';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { siteConfig } from '@/lib/home';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { NewAgentDialog } from '@/components/agents/new-agent-dialog';
import { ThreadSearchModal } from '@/components/sidebar/thread-search-modal';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useTheme } from 'next-themes';
import { useRouter } from 'next/navigation';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { useIsMobile } from '@/hooks/utils';
import { cn } from '@/lib/utils';
import { usePathname, useSearchParams } from 'next/navigation';
import posthog from 'posthog-js';
import { useDocumentModalStore } from '@/stores/use-document-modal-store';
import { useSubscriptionData } from '@/stores/subscription-store';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import Image from 'next/image';
import { isLocalMode } from '@/lib/config';
import { KortixProcessModal } from './kortix-enterprise-modal';

import { getPlanIcon, getPlanName } from '@/components/billing/plan-utils';

// Helper function to get user initials
function getInitials(name: string) {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

function UserProfileSection({ user }: { user: any }) {
  const { data: subscriptionData } = useSubscriptionData();
  const { state } = useSidebar();
  const isLocal = isLocalMode();
  const planName = getPlanName(subscriptionData, isLocal);

  // Return the enhanced user object with plan info for NavUserWithTeams
  const enhancedUser = {
    ...user,
    planName,
    planIcon: getPlanIcon(planName, isLocal)
  };

  return <NavUserWithTeams user={enhancedUser} />;
}

function FloatingMobileMenuButton() {
  const { setOpenMobile, openMobile, setOpen } = useSidebar();
  const isMobile = useIsMobile();

  if (!isMobile || openMobile) return null;

  return (
    <div className="fixed top-6 left-4 z-50">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            onClick={() => {
              setOpen(true);
              setOpenMobile(true);
            }}
            size="icon"
            className="h-10 w-10 rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 transition-all duration-200 hover:scale-105 active:scale-95 touch-manipulation"
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          Open menu
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

export function SidebarLeft({
  ...props
}: React.ComponentProps<typeof Sidebar>) {
  const { state, setOpen, setOpenMobile } = useSidebar();
  const isMobile = useIsMobile();
  const { theme, setTheme } = useTheme();
  const router = useRouter();
  const [activeView, setActiveView] = useState<'chats' | 'agents' | 'starred'>('chats');
  const [showEnterpriseCard, setShowEnterpriseCard] = useState(true);
  const [user, setUser] = useState<{
    name: string;
    email: string;
    avatar: string;
    isAdmin?: boolean;
  }>({
    name: 'Loading...',
    email: 'loading@example.com',
    avatar: '',
    isAdmin: false,
  });

  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [showNewAgentDialog, setShowNewAgentDialog] = useState(false);
  const [showSearchModal, setShowSearchModal] = useState(false);
  const { isOpen: isDocumentModalOpen } = useDocumentModalStore();

  // Update active view based on pathname
  useEffect(() => {
    if (pathname?.includes('/triggers') || pathname?.includes('/knowledge')) {
      setActiveView('starred');
    }
  }, [pathname]);

  // Logout handler
  const handleLogout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
  };

  useEffect(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [pathname, searchParams, isMobile, setOpenMobile]);


  useEffect(() => {
    const fetchUserData = async () => {
      const supabase = createClient();
      const { data } = await supabase.auth.getUser();
      if (data.user) {
        const { data: roleData } = await supabase
          .from('user_roles')
          .select('role')
          .eq('user_id', data.user.id)
          .in('role', ['admin', 'super_admin']);
        const isAdmin = roleData && roleData.length > 0;

        setUser({
          name:
            data.user.user_metadata?.name ||
            data.user.email?.split('@')[0] ||
            'User',
          email: data.user.email || '',
          avatar: data.user.user_metadata?.avatar_url || '', // User avatar (different from agent avatar)
          isAdmin: isAdmin,
        });
      }
    };

    fetchUserData();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isDocumentModalOpen) return;

      // CMD+B to toggle sidebar
      if ((event.metaKey || event.ctrlKey) && event.key === 'b') {
        event.preventDefault();
        setOpen(!state.startsWith('expanded'));
        window.dispatchEvent(
          new CustomEvent('sidebar-left-toggled', {
            detail: { expanded: !state.startsWith('expanded') },
          }),
        );
      }

      // CMD+K to open search modal
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault();
        setShowSearchModal(true);
      }

      // CMD+J to open new chat
      if ((event.metaKey || event.ctrlKey) && event.key === 'j') {
        event.preventDefault();
        posthog.capture('new_task_clicked', { source: 'keyboard_shortcut' });
        router.push('/dashboard');
        if (isMobile) {
          setOpenMobile(false);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [state, setOpen, isDocumentModalOpen, router, isMobile, setOpenMobile]);




  return (
    <Sidebar
      collapsible="icon"
      className="border-r border-border/50 bg-background [&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:'none']"
      {...props}
    >
      <SidebarHeader className={cn("px-6 pt-7 overflow-hidden", state === 'collapsed' && "px-6")}>
        <div className={cn("flex h-[32px] items-center justify-between min-w-[200px]")}>
          <div className="">
            {state === 'collapsed' ? (
              <div className="pl-2 relative flex items-center justify-center w-fit group/logo">
                <Link href="/dashboard" onClick={() => isMobile && setOpenMobile(false)}>
                  <KortixLogo size={20} className="flex-shrink-0 opacity-100 group-hover/logo:opacity-0 transition-opacity" />
                </Link>
                <Tooltip delayDuration={2000}>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 absolute opacity-0 group-hover/logo:opacity-100 transition-opacity"
                      onClick={() => setOpen(true)}
                    >
                      <PanelLeftOpen className="!h-5 !w-5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Expand sidebar (CMD+B)</TooltipContent>
                </Tooltip>
              </div>
            ) : (
              <div className="pl-2 relative flex items-center justify-center w-fit">
                <Link href="/dashboard" onClick={() => isMobile && setOpenMobile(false)}>
                  <KortixLogo size={20} className="flex-shrink-0" />
                </Link>
              </div>
            )}

          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => {
              if (isMobile) {
                setOpenMobile(false);
              } else {
                setOpen(false);
              }
            }}
          >
            <PanelLeftClose className="!h-5 !w-5" />
          </Button>
        </div>
      </SidebarHeader >
      <SidebarContent className="[&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:'none']">
        <AnimatePresence mode="wait">
          {state === 'collapsed' ? (
            /* Collapsed layout: + button and 4 state buttons only */
            <motion.div
              key="collapsed"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
              className="px-6 pt-4 space-y-3 flex flex-col items-center"
            >
              {/* + button */}
              <div className="w-full flex justify-center">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-10 w-10 p-0 shadow-none"
                  asChild
                >
                  <Link
                    href="/dashboard"
                    onClick={() => {
                      posthog.capture('new_task_clicked');
                      if (isMobile) setOpenMobile(false);
                    }}
                  >
                    <Plus className="h-4 w-4" />
                  </Link>
                </Button>
              </div>

              {/* State buttons vertically */}
              <div className="w-full flex flex-col items-center space-y-3">
                {[
                  { view: 'chats' as const, icon: MessageCircle },
                  { view: 'agents' as const, icon: Bot },
                  { view: 'starred' as const, icon: Zap },
                ].map(({ view, icon: Icon }) => (
                  <Button
                    key={view}
                    variant="ghost"
                    size="icon"
                    className={cn(
                      "h-10 w-10 p-0 cursor-pointer hover:bg-card hover:border-[1.5px] hover:border-border",
                      activeView === view ? 'bg-card border-[1.5px] border-border' : ''
                    )}
                    onClick={() => {
                      setActiveView(view);
                      setOpen(true); // Expand sidebar when clicking state button
                    }}
                  >
                    <Icon className="!h-4 !w-4" />
                  </Button>
                ))}
              </div>
            </motion.div>
          ) : (
            /* Expanded layout */
            <motion.div
              key="expanded"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
              className="flex flex-col h-full"
            >
              <div className="px-6 pt-4 space-y-4">
                {/* New Chat button */}
                <div className="w-full">
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full shadow-none justify-between h-10 px-4"
                    asChild
                  >
                    <Link
                      href="/dashboard"
                      onClick={() => {
                        posthog.capture('new_task_clicked');
                        if (isMobile) setOpenMobile(false);
                      }}
                    >
                      <div className="flex items-center gap-2">
                        <Plus className="h-4 w-4" />
                        New Chat
                      </div>
                      <div className="flex items-center gap-1">
                        <kbd className="h-6 w-6 flex items-center justify-center bg-muted border border-border rounded-md text-base leading-0 cursor-pointer">⌘</kbd>
                        <kbd className="h-6 w-6 flex items-center justify-center bg-muted border border-border rounded-md text-xs cursor-pointer">J</kbd>
                      </div>
                    </Link>
                  </Button>
                </div>

                {/* State buttons horizontally */}
                <div className="flex justify-between items-center gap-2">
                  {[
                    { view: 'chats' as const, icon: MessageCircle, label: 'Chats' },
                    { view: 'agents' as const, icon: Bot, label: 'Workers' },
                    { view: 'starred' as const, icon: Zap, label: 'Triggers' }
                  ].map(({ view, icon: Icon, label }) => (
                    <button
                      key={view}
                      className={cn(
                        "flex flex-col items-center justify-center gap-1.5 p-1.5 rounded-2xl cursor-pointer transition-colors w-[64px] h-[64px]",
                        "hover:bg-muted/60 hover:border-[1.5px] hover:border-border",
                        activeView === view ? 'bg-card border-[1.5px] border-border' : 'border-[1.5px] border-transparent'
                      )}
                      onClick={() => setActiveView(view)}
                    >
                      <Icon className="!h-4 !w-4" />
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        {label}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Content area */}
              <div className="px-6 flex-1 overflow-hidden">
                {activeView === 'chats' && <NavAgents />}
                {activeView === 'agents' && <NavAgentsView />}
                {activeView === 'starred' && (
                  <>
                    <NavGlobalConfig />
                    <NavTriggerRuns />
                  </>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </SidebarContent>

      {/* Enterprise Demo Card - Only show when expanded */}
      {/* {
        state !== 'collapsed' && showEnterpriseCard && (
          <div className="absolute bottom-[86px] left-6 right-6 z-10">
            <div className="rounded-2xl p-5 backdrop-blur-[12px] border-[1.5px] bg-gradient-to-br from-white/25 to-gray-300/25 dark:from-gray-600/25 dark:to-gray-800/25 border-gray-300/50 dark:border-gray-600/50">
              <div className="flex items-center gap-2 mb-3">
                <Sparkles className="h-4 w-4" />
                <span className="text-sm font-medium text-foreground">Enterprise Demo</span>

                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                  onClick={() => setShowEnterpriseCard(false)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mb-4">
                Request custom AI Workers implementation
              </p>
              <KortixProcessModal>
                <Button size="sm" className="w-full text-xs h-8">
                  Learn More
                </Button>
              </KortixProcessModal>
            </div>
          </div>
        )
      } */}

      <div className={cn("pb-4", state === 'collapsed' ? "px-6" : "px-6")}>
        <UserProfileSection user={user} />
      </div>
      <SidebarRail />
      <NewAgentDialog
        open={showNewAgentDialog}
        onOpenChange={setShowNewAgentDialog}
      />
      <ThreadSearchModal
        open={showSearchModal}
        onOpenChange={setShowSearchModal}
      />
    </Sidebar >
  );
}

// Export the floating button so it can be used in the layout
export { FloatingMobileMenuButton };
