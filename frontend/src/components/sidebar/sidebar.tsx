'use client';

import * as React from 'react';
import Link from 'next/link';
import { 
  Plus, 
  Search, 
  Library, 
  FolderPlus, 
  ChevronDown,
  PanelLeftOpen, 
  PanelLeftClose,
  Menu
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

import { TaskList } from '@/components/sidebar/task-list';
import { UserMenu } from '@/components/sidebar/user-menu';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar';
import { NewAgentDialog } from '@/components/agents/new-agent-dialog';
import { SearchModal } from '@/components/sidebar/search-modal';
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
import { useAdminRole } from '@/hooks/admin';
import posthog from 'posthog-js';
import { useDocumentModalStore } from '@/stores/use-document-modal-store';
import { isLocalMode } from '@/lib/config';
import { useAccountState, accountStateSelectors } from '@/hooks/billing';
import { getPlanIcon } from '@/components/billing/plan-utils';
import { Kbd, KbdGroup } from '../ui/kbd';
import { useTranslations } from 'next-intl';


function UserProfileSection({ user }: { user: any }) {
  const { data: accountState } = useAccountState({ enabled: true });
  const { state } = useSidebar();
  const isLocal = isLocalMode();
  const planName = accountStateSelectors.planName(accountState);

  const enhancedUser = {
    ...user,
    planName,
    planIcon: getPlanIcon(planName, isLocal)
  };

  return <UserMenu user={enhancedUser} />;
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

// Menu item component for consistent styling
function MenuItem({ 
  icon: Icon, 
  label, 
  onClick, 
  active = false,
  kbd,
  className
}: { 
  icon: React.ElementType; 
  label: string; 
  onClick?: () => void;
  active?: boolean;
  kbd?: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-all duration-200 group",
        active 
          ? "bg-foreground/[0.08] text-foreground font-medium" 
          : "text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04]",
        className
      )}
    >
      <Icon className="h-[18px] w-[18px] flex-shrink-0" strokeWidth={1.8} />
      <span className="flex-1 text-left">{label}</span>
      {kbd && (
        <span className="opacity-0 group-hover:opacity-100 transition-opacity">
          {kbd}
        </span>
      )}
    </button>
  );
}

// Section header component
function SectionHeader({ 
  label, 
  onAdd,
  isExpanded,
  onToggle
}: { 
  label: string; 
  onAdd?: () => void;
  isExpanded?: boolean;
  onToggle?: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-3 py-2">
      <button 
        onClick={onToggle}
        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground/70 uppercase tracking-wider hover:text-muted-foreground transition-colors"
      >
        {onToggle && (
          <ChevronDown 
            className={cn(
              "h-3 w-3 transition-transform duration-200",
              !isExpanded && "-rotate-90"
            )} 
          />
        )}
        {label}
      </button>
      {onAdd && (
        <button
          onClick={onAdd}
          className="p-1 rounded-md text-muted-foreground/60 hover:text-muted-foreground hover:bg-foreground/[0.04] transition-all"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

export function AppSidebar({
  ...props
}: React.ComponentProps<typeof Sidebar>) {
  const t = useTranslations('sidebar');
  const { state, setOpen, setOpenMobile } = useSidebar();
  const isMobile = useIsMobile();
  const { theme, setTheme } = useTheme();
  const router = useRouter();
  const [tasksExpanded, setTasksExpanded] = useState(true);
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
          avatar: data.user.user_metadata?.avatar_url || '',
          isAdmin: isAdmin,
        });
      }
    };

    fetchUserData();
  }, [isAdmin]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isDocumentModalOpen) return;

      const el = document.activeElement;
      const isEditing = el && (
        el.tagName.toLowerCase() === 'input' ||
        el.tagName.toLowerCase() === 'textarea' ||
        el.getAttribute('contenteditable') === 'true' ||
        el.closest('.cm-editor') ||
        el.closest('.ProseMirror')
      );

      if ((event.metaKey || event.ctrlKey) && event.key === 'b' && !isEditing) {
        event.preventDefault();
        setOpen(!state.startsWith('expanded'));
        window.dispatchEvent(
          new CustomEvent('sidebar-left-toggled', {
            detail: { expanded: !state.startsWith('expanded') },
          }),
        );
      }

      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault();
        setShowSearchModal(true);
      }

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

  const isOnDashboard = pathname === '/dashboard';

  return (
    <Sidebar
      collapsible="icon"
      className="border-r border-border/40 bg-background [&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:'none']"
      {...props}
    >
      <SidebarHeader className={cn("px-4 pt-5 overflow-hidden", state === 'collapsed' && "px-3")}>
        {state === 'collapsed' ? (
          <div className="flex h-[36px] items-center justify-center">
            <div className="relative flex items-center justify-center w-fit group/logo">
              <Link href="/dashboard" onClick={() => isMobile && setOpenMobile(false)}>
                <KortixLogo size={18} className="flex-shrink-0 opacity-100 group-hover/logo:opacity-0 transition-opacity" />
              </Link>
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 p-0 cursor-pointer !bg-transparent hover:!bg-transparent border-0 hover:border-0 absolute opacity-0 group-hover/logo:opacity-100 transition-opacity [&_svg]:!size-5"
                onClick={() => setOpen(true)}
                aria-label="Expand sidebar"
              >
                <PanelLeftOpen className="!h-5 !w-5" />
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex h-[36px] items-center justify-between">
            <Link 
              href="/dashboard" 
              onClick={() => isMobile && setOpenMobile(false)}
              className="flex items-center gap-2.5"
            >
              <KortixLogo size={18} className="flex-shrink-0 transition-transform duration-500 hover:rotate-180" />
            </Link>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-foreground"
              onClick={() => {
                if (isMobile) {
                  setOpenMobile(false);
                } else {
                  setOpen(false);
                }
              }}
            >
              <PanelLeftClose className="!h-[18px] !w-[18px]" />
            </Button>
          </div>
        )}
      </SidebarHeader>
      
      <SidebarContent className="[&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:'none']">
        <AnimatePresence mode="wait">
          {state === 'collapsed' ? (
            <motion.div
              key="collapsed"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
              className="px-3 pt-4 space-y-2 flex flex-col items-center"
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="default"
                    size="icon"
                    className="h-9 w-9 rounded-xl"
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
                </TooltipTrigger>
                <TooltipContent side="right">{t('newChat')}</TooltipContent>
              </Tooltip>
              
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 text-muted-foreground hover:text-foreground"
                    onClick={() => setShowSearchModal(true)}
                  >
                    <Search className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">Search</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 text-muted-foreground hover:text-foreground"
                    asChild
                  >
                    <Link href="/knowledge">
                      <Library className="h-4 w-4" />
                    </Link>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">Library</TooltipContent>
              </Tooltip>
            </motion.div>
          ) : (
            <motion.div
              key="expanded"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
              className="flex flex-col h-full"
            >
              {/* Primary Actions */}
              <div className="px-3 pt-4 space-y-1">
                {/* New Task - Primary CTA */}
                <Link
                  href="/dashboard"
                  onClick={() => {
                    posthog.capture('new_task_clicked');
                    if (isMobile) setOpenMobile(false);
                  }}
                  className={cn(
                    "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-all duration-200 group",
                    isOnDashboard
                      ? "bg-foreground text-background font-medium"
                      : "bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.1] font-medium"
                  )}
                >
                  <div className={cn(
                    "h-[18px] w-[18px] rounded-md flex items-center justify-center flex-shrink-0",
                    isOnDashboard ? "bg-background/20" : "bg-foreground/10"
                  )}>
                    <Plus className="h-3.5 w-3.5" strokeWidth={2} />
                  </div>
                  <span className="flex-1 text-left">{t('newChat')}</span>
                  <span className="opacity-0 group-hover:opacity-100 transition-opacity">
                    <KbdGroup>
                      <Kbd>⌘</Kbd>
                      <Kbd>J</Kbd>
                    </KbdGroup>
                  </span>
                </Link>

                {/* Search */}
                <MenuItem
                  icon={Search}
                  label="Search"
                  onClick={() => setShowSearchModal(true)}
                  kbd={
                    <KbdGroup>
                      <Kbd>⌘</Kbd>
                      <Kbd>K</Kbd>
                    </KbdGroup>
                  }
                />

                {/* Library */}
                <Link href="/knowledge" className="block">
                  <MenuItem
                    icon={Library}
                    label="Library"
                    active={pathname?.includes('/knowledge')}
                  />
                </Link>
              </div>

              {/* Projects Section */}
              <div className="px-3 pt-6">
                <SectionHeader 
                  label="Projects" 
                  onAdd={() => {
                    posthog.capture('new_task_clicked');
                    router.push('/dashboard');
                    if (isMobile) setOpenMobile(false);
                  }}
                />
                <button
                  onClick={() => {
                    posthog.capture('new_task_clicked');
                    router.push('/dashboard');
                    if (isMobile) setOpenMobile(false);
                  }}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04] transition-all"
                >
                  <FolderPlus className="h-[18px] w-[18px]" strokeWidth={1.8} />
                  <span>New project</span>
                </button>
              </div>

              {/* All Tasks Section */}
              <div className="px-3 pt-4 flex-1 overflow-hidden flex flex-col">
                <SectionHeader 
                  label="All tasks" 
                  isExpanded={tasksExpanded}
                  onToggle={() => setTasksExpanded(!tasksExpanded)}
                />
                
                <AnimatePresence>
                  {tasksExpanded && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.2, ease: "easeOut" }}
                      className="flex-1 overflow-hidden"
                    >
                      <TaskList />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </SidebarContent>

      <div className={cn("pb-4", state === 'collapsed' ? "px-3" : "px-4")}>
        <UserProfileSection user={user} />
      </div>
      <SidebarRail />
      <NewAgentDialog
        open={showNewAgentDialog}
        onOpenChange={setShowNewAgentDialog}
      />
      <SearchModal
        open={showSearchModal}
        onOpenChange={setShowSearchModal}
      />
    </Sidebar>
  );
}

// Legacy export for backward compatibility
export const SidebarLeft = AppSidebar;

export { FloatingMobileMenuButton };

