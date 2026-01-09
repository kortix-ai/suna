'use client';

import * as React from 'react';
import Link from 'next/link';
import { Library, Menu, Plus, Zap, MessageCircle, PanelLeftOpen, PanelLeftClose, Search } from 'lucide-react';

import { NavAgents } from '@/components/sidebar/nav-agents';
import { NavAgentsView } from '@/components/sidebar/nav-agents-view';
import { NavGlobalConfig } from '@/components/sidebar/nav-global-config';
import { NavTriggerRuns } from '@/components/sidebar/nav-trigger-runs';
import { NavUserWithTeams } from '@/components/sidebar/nav-user-with-teams';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { siteConfig } from '@/lib/site-config';
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar';
import { NewAgentDialog } from '@/components/agents/new-agent-dialog';
import { ThreadSearchModal } from '@/components/sidebar/thread-search-modal';
import { useEffect, useState, useMemo } from 'react';
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
import { useAdminRole } from '@/hooks/admin';
import posthog from 'posthog-js';
import { useDocumentModalStore } from '@/stores/use-document-modal-store';
import { isLocalMode } from '@/lib/config';
import { useAccountState, accountStateSelectors } from '@/hooks/billing';
import { useThreads } from '@/hooks/threads/use-threads';

import { getPlanIcon } from '@/components/billing/plan-utils';
import { Kbd } from '../ui/kbd';
import { useTranslations } from 'next-intl';
import { KbdGroup } from '../ui/kbd';


function UserProfileSection({ user }: { user: any }) {
  const { data: accountState } = useAccountState({ enabled: true });
  const { state } = useSidebar();
  const isLocal = isLocalMode();
  const planName = accountStateSelectors.planName(accountState);

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
  const t = useTranslations('sidebar');
  const { state, setOpen, setOpenMobile } = useSidebar();
  const isMobile = useIsMobile();
  const { theme, setTheme } = useTheme();
  const router = useRouter();
  const [activeView, setActiveView] = useState<'chats' | 'library' | 'starred'>('chats');
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

  // Fetch threads for navigation between library and chat
  const { data: threadsData } = useThreads({ page: 1, limit: 200 });

  // Extract projectId and threadId from current pathname
  const { currentProjectId, currentThreadId, isOnLibrary, isOnThread } = useMemo(() => {
    if (!pathname) return { currentProjectId: null, currentThreadId: null, isOnLibrary: false, isOnThread: false };
    
    // Match /library/{projectId}
    const libraryMatch = pathname.match(/^\/library\/([^\/]+)/);
    if (libraryMatch) {
      return { currentProjectId: libraryMatch[1], currentThreadId: null, isOnLibrary: true, isOnThread: false };
    }
    
    // Match /projects/{projectId}/thread/{threadId}
    const threadMatch = pathname.match(/^\/projects\/([^\/]+)\/thread\/([^\/]+)/);
    if (threadMatch) {
      return { currentProjectId: threadMatch[1], currentThreadId: threadMatch[2], isOnLibrary: false, isOnThread: true };
    }
    
    return { currentProjectId: null, currentThreadId: null, isOnLibrary: false, isOnThread: false };
  }, [pathname]);

  // Find thread for current project (for navigating from library to chat)
  const threadForCurrentProject = useMemo(() => {
    if (!currentProjectId || !threadsData?.threads) return null;
    return threadsData.threads.find(t => t.project_id === currentProjectId);
  }, [currentProjectId, threadsData]);

  // Update active view based on pathname
  useEffect(() => {
    if (pathname?.includes('/triggers') || pathname?.includes('/knowledge')) {
      setActiveView('starred');
    } else if (isOnLibrary) {
      setActiveView('library');
    } else if (isOnThread) {
      setActiveView('chats');
    }
  }, [pathname, isOnLibrary, isOnThread]);

  // Track if we're doing a library<->chat switch (to prevent sidebar collapse)
  const [isLibraryChatSwitch, setIsLibraryChatSwitch] = useState(false);

  // Handle view switching with navigation
  const handleViewChange = (view: 'chats' | 'library' | 'starred') => {
    // If switching to library while on a thread, navigate to that project's library
    if (view === 'library' && isOnThread && currentProjectId) {
      setIsLibraryChatSwitch(true);
      router.push(`/library/${currentProjectId}`);
      return;
    }
    
    // If switching to chats while on library, navigate to that project's thread
    if (view === 'chats' && isOnLibrary && currentProjectId && threadForCurrentProject) {
      setIsLibraryChatSwitch(true);
      router.push(`/projects/${currentProjectId}/thread/${threadForCurrentProject.thread_id}`);
      return;
    }
    
    // Otherwise just switch the view
    setActiveView(view);
  };

  // Logout handler
  const handleLogout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
  };

  useEffect(() => {
    if (isMobile) {
      // Don't collapse sidebar when switching between library and chat
      if (isLibraryChatSwitch) {
        setIsLibraryChatSwitch(false);
        return;
      }
      setOpenMobile(false);
    }
  }, [pathname, searchParams, isMobile, setOpenMobile, isLibraryChatSwitch]);


  // Use React Query hook for admin role instead of direct fetch
  const { data: adminRoleData } = useAdminRole();
  const isAdmin = adminRoleData?.isAdmin ?? false;

  useEffect(() => {
    const fetchUserData = async () => {
      const supabase = createClient();
      const { data } = await supabase.auth.getUser();
      if (data.user) {
        setUser({
          name:
            data.user.user_metadata?.name ||
            data.user.email?.split('@')[0] ||
            'User',
          email: data.user.email || '',
          avatar: data.user.user_metadata?.avatar_url || '', // User avatar (different from agent avatar)
          isAdmin: isAdmin, // Use React Query cached value
        });
      }
    };

    fetchUserData();
  }, [isAdmin]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isDocumentModalOpen) return;

      // Skip if user is in an editable element (editor, input, textarea)
      const el = document.activeElement;
      const isEditing = el && (
        el.tagName.toLowerCase() === 'input' ||
        el.tagName.toLowerCase() === 'textarea' ||
        el.getAttribute('contenteditable') === 'true' ||
        el.closest('.cm-editor') ||
        el.closest('.ProseMirror')
      );

      // CMD+B to toggle sidebar (skip if editing)
      if ((event.metaKey || event.ctrlKey) && event.key === 'b' && !isEditing) {
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
      <SidebarHeader className="pt-4 overflow-visible">
        <div className="relative flex h-[32px] items-center">
          {/* Logo - fixed position at 32px from left, never moves */}
          <div className="absolute left-6 flex items-center justify-center group/logo">

            <Link href="/dashboard" onClick={() => isMobile && setOpenMobile(false)} className="flex items-center justify-center">
              <KortixLogo 
                size={20} 
                className={cn(
                  "flex-shrink-0 transition-[transform,opacity] duration-300 ease-out hover:rotate-180 hover:duration-700 transform-gpu",
                  state === 'collapsed' && "group-hover/logo:opacity-0 group-hover/logo:scale-90"
                )} 
              />
            </Link>
            {/* Expand button - only shows on hover when collapsed */}
            {state === 'collapsed' && (
              <button
                className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center justify-center cursor-pointer opacity-0 scale-75 group-hover/logo:opacity-100 group-hover/logo:scale-100 transition-[opacity,transform] duration-300 ease-out transform-gpu"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setOpen(true);
                }}
                aria-label="Expand sidebar"
              >
                <PanelLeftOpen className="h-5 w-5" />
              </button>
            )}
          </div>
          
          {/* Right side buttons - fade in/out, positioned at the right */}
          <div 
            className={cn(
              "absolute right-6 flex items-center gap-1 transition-[opacity,right] duration-300 ease-out transform-gpu",
              state === 'collapsed' 
                ? "opacity-0 pointer-events-none right-0" 
                : "opacity-100 pointer-events-auto"
            )}
          >
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setShowSearchModal(true)}
            >
              <Search className="!h-5 !w-5" />
            </Button>
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
        </div>
      </SidebarHeader>
      <SidebarContent className="[&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:'none'] relative overflow-hidden">
        {/* Collapsed layout: + button and state buttons only */}
        <div
          className={cn(
            "absolute inset-0 px-6 pt-4 space-y-3 flex flex-col items-center transition-opacity duration-150 ease-out transform-gpu",
            state === 'collapsed' 
              ? "opacity-100 pointer-events-auto delay-100" 
              : "opacity-0 pointer-events-none delay-0"
          )}
        >
          {/* + button */}
          <div className="w-full flex flex-col items-center space-y-3">
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
          <div className="w-full flex flex-col items-center space-y-3">
            {[
              { view: 'chats' as const, icon: MessageCircle },
              { view: 'library' as const, icon: Library },
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
                  handleViewChange(view);
                  setOpen(true); // Expand sidebar when clicking state button
                }}
              >
                <Icon className="!h-4 !w-4" />
              </Button>
            ))}
          </div>
        </div>

        {/* Expanded layout */}
        <div
          className={cn(
            "flex flex-col h-full transition-opacity duration-150 ease-out transform-gpu",
            state === 'collapsed' 
              ? "opacity-0 pointer-events-none delay-0" 
              : "opacity-100 pointer-events-auto delay-100"
          )}
        >
          <div className="px-6 pt-4 space-y-4">
            {/* New Chat button */}
            <div className="w-full">
              <Button
                variant="outline"
                size="sm"
                className="w-full shadow-none justify-between h-10 px-3 group/new-chat"
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
                    {t('newChat')}
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover/new-chat:opacity-100 transition-opacity">
                  <KbdGroup>
                    <Kbd>⌘</Kbd>
                    <Kbd>J</Kbd>
                  </KbdGroup>
                  </div>
                </Link>
              </Button>
            </div>

            {/* State buttons horizontally */}
            <div className="flex justify-between items-center gap-2">
              {[
                { view: 'chats' as const, icon: MessageCircle, label: t('chats') },
                { view: 'library' as const, icon: Library, label: t('library') },
                { view: 'starred' as const, icon: Zap, label: t('triggers') }
              ].map(({ view, icon: Icon, label }) => (
                <button
                  key={view}
                  className={cn(
                    "flex flex-col items-center justify-center gap-1.5 p-1.5 rounded-2xl cursor-pointer transition-colors w-[64px] h-[64px]",
                    "hover:bg-muted/60 hover:border-[1.5px] hover:border-border",
                    activeView === view ? 'bg-card border-[1.5px] border-border' : 'border-[1.5px] border-transparent'
                  )}
                  onClick={() => handleViewChange(view)}
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
            {activeView === 'library' && <NavAgentsView />}
            {activeView === 'starred' && (
              <>
                <NavGlobalConfig />
                <NavTriggerRuns />
              </>
            )}
          </div>
        </div>
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
    </Sidebar>
  );
}

// Export the floating button so it can be used in the layout
export { FloatingMobileMenuButton };
