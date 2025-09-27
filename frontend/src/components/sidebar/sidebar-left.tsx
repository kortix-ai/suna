'use client';

import * as React from 'react';
import Link from 'next/link';
import { Bot, Menu, Plus, Zap, ChevronRight, BookOpen, Code, Star, Package, Sparkle, Sparkles, X, AlarmClock, Check, Clipboard, ClipboardCheck } from 'lucide-react';

import { NavAgents } from '@/components/sidebar/nav-agents';
import { NavUserWithTeams } from '@/components/sidebar/nav-user-with-teams';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { CTACard } from '@/components/sidebar/cta';
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
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import { usePathname, useSearchParams } from 'next/navigation';
import posthog from 'posthog-js';
import { useDocumentModalStore } from '@/lib/stores/use-document-modal-store';
import { useSubscriptionData } from '@/contexts/SubscriptionContext';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import Image from 'next/image';
import { isLocalMode } from '@/lib/config';

// Helper function to get plan icon
function getPlanIcon(planName: string, isLocal: boolean = false) {
  if (isLocal) return '/plan-icons/ultra.svg';

  const plan = planName?.toLowerCase();
  if (plan?.includes('ultra')) return '/plan-icons/ultra.svg';
  if (plan?.includes('pro')) return '/plan-icons/pro.svg';
  if (plan?.includes('plus')) return '/plan-icons/plus.svg';
  return '/plan-icons/plus.svg'; // default
}

// Helper function to get plan name
function getPlanName(subscriptionData: any, isLocal: boolean = false): string {
  if (isLocal) return 'Ultra';
  return subscriptionData?.plan_name || subscriptionData?.tier?.name || 'Free';
}

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
  const { setOpenMobile, openMobile } = useSidebar();
  const isMobile = useIsMobile();

  if (!isMobile || openMobile) return null;

  return (
    <div className="fixed top-6 left-4 z-50">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            onClick={() => setOpenMobile(true)}
            size="icon"
            className="h-12 w-12 rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 transition-all duration-200 hover:scale-105 active:scale-95 touch-manipulation"
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
  const [activeView, setActiveView] = useState<'chats' | 'tasks' | 'agents' | 'starred'>('chats');
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
  const { isOpen: isDocumentModalOpen } = useDocumentModalStore();

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
          avatar: data.user.user_metadata?.avatar_url || '',
          isAdmin: isAdmin,
        });
      }
    };

    fetchUserData();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isDocumentModalOpen) return;

      if ((event.metaKey || event.ctrlKey) && event.key === 'b') {
        event.preventDefault();
        setOpen(!state.startsWith('expanded'));
        window.dispatchEvent(
          new CustomEvent('sidebar-left-toggled', {
            detail: { expanded: !state.startsWith('expanded') },
          }),
        );
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [state, setOpen, isDocumentModalOpen]);




  return (
    <Sidebar
      collapsible="icon"
      className="border-r border-border/50 bg-background [&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:'none'] [&[data-state=expanded]]:w-80 w-80"
      {...props}
    >
      <SidebarHeader className="px-6 py-3">
        <div className="flex h-[32px] items-center justify-between">
          <Link href="/dashboard" className="flex-shrink-0" onClick={() => isMobile && setOpenMobile(false)}>
            <KortixLogo size={24} />
          </Link>
          {state !== 'collapsed' && !isMobile && (
            <Tooltip>
              <TooltipTrigger asChild>
                <SidebarTrigger className="h-8 w-8" />
              </TooltipTrigger>
              <TooltipContent>Toggle sidebar (CMD+B)</TooltipContent>
            </Tooltip>
          )}
        </div>
      </SidebarHeader>
      <SidebarContent className="[&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:'none']">
        <div className="px-[34px] pt-4 space-y-4">
          {/* New Chat button with shortcuts inside */}
          <Button
            variant="outline"
            size="sm"
            className="w-full shadow-none justify-between h-12 rounded-2xl px-4"
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
                <kbd className="h-6 w-6 flex items-center justify-center bg-muted border border-border rounded-md text-xs cursor-pointer">K</kbd>
              </div>
            </Link>
          </Button>

          {/* Four 48x48 icon buttons with 16px radius */}
          <div className="grid grid-cols-4 gap-3">
            {[
              { view: 'chats' as const, icon: AlarmClock },
              { view: 'tasks' as const, icon: ClipboardCheck },
              { view: 'agents' as const, icon: Bot },
              { view: 'starred' as const, icon: Star }
            ].map(({ view, icon: Icon }) => (
              <Button
                key={view}
                variant="ghost"
                size="icon"
                className={`h-12 w-12 p-0 rounded-2xl cursor-pointer hover:bg-muted/60 hover:border-[1.5px] hover:border-border ${activeView === view ? 'bg-muted/60 border-[1.5px] border-border' : ''
                  }`}
                onClick={() => setActiveView(view)}
              >
                <Icon className="h-5 w-5" />
              </Button>
            ))}
          </div>          {/* My Workers / Community toggle - Only show for agents view */}
          {activeView === 'agents' && (
            <div className="flex items-center gap-2">
              <Button
                variant="default"
                size="sm"
                className="flex-1 justify-center gap-2 h-12 rounded-2xl"
                asChild
              >
                <Link href="/agents">
                  <Bot className="h-4 w-4" />
                  My Workers
                </Link>
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="flex-1 justify-center gap-2 h-12 rounded-2xl"
                asChild
              >
                <Link href="/community">
                  <Package className="h-4 w-4" />
                  Community
                </Link>
              </Button>
            </div>
          )}
        </div>

        <div className="px-6">
          {/* Conditional content based on active view */}
          {activeView === 'chats' && <NavAgents />}
          {activeView === 'tasks' && <NavAgents />}
          {activeView === 'agents' && <NavAgents />}
          {activeView === 'starred' && (
            <div className="text-center py-8 text-muted-foreground">
              <Star className="h-8 w-8 mx-auto mb-2" />
              <p className="text-sm">No starred items yet</p>
            </div>
          )}
        </div>

      </SidebarContent>

      {/* Enterprise Demo Card - Floating overlay above footer */}
      <div className="absolute bottom-[96px] left-6 right-6 z-10">
        <div className="rounded-2xl p-5 backdrop-blur-[12px] border-[1.5px] bg-gradient-to-br from-white/25 to-gray-300/25 dark:from-gray-600/25 dark:to-gray-800/25 border-gray-300/50 dark:border-gray-600/50">
          <div className="flex items-center gap-2 mb-3">
            <Sparkles className="h-4 w-4" />
            <span className="text-sm font-medium text-foreground">Enterprise Demo</span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mb-4">
            Request custom AI Workers implementation
          </p>
          <Button size="sm" className="w-full text-xs h-8">
            Learn More
          </Button>
        </div>
      </div>

      <div className="px-6 pb-4">
        {state === 'collapsed' && (
          <div className="mt-2 flex justify-center">
            <Tooltip>
              <TooltipTrigger asChild>
                <SidebarTrigger className="h-8 w-8" />
              </TooltipTrigger>
              <TooltipContent>Expand sidebar (CMD+B)</TooltipContent>
            </Tooltip>
          </div>
        )}
        <UserProfileSection user={user} />
      </div>
      <SidebarRail />
      <NewAgentDialog
        open={showNewAgentDialog}
        onOpenChange={setShowNewAgentDialog}
      />
    </Sidebar>
  );
}

// Export the floating button so it can be used in the layout
export { FloatingMobileMenuButton };
