"use client"

import * as React from "react"
import Link from "next/link"
import { Menu } from "lucide-react"

import { NavAgents } from "@/components/sidebar/nav-agents"
import { NavUserWithTeams } from "@/components/sidebar/nav-user-with-teams"
import { KortixLogo } from "@/components/sidebar/kortix-logo"
import { CTACard } from "@/components/sidebar/cta"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar"
import { useEffect, useState } from "react"
import { createClient } from "@/lib/supabase/client"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@/components/ui/tooltip"
import { useIsMobile } from "@/hooks/use-mobile"

export function SidebarLeft({
  ...props
}: React.ComponentProps<typeof Sidebar>) {
  const { state, setOpen, setOpenMobile } = useSidebar()
  const isMobile = useIsMobile()
  const [user, setUser] = useState<{
    name: string;
    email: string;
    avatar: string;
  }>({
    name: "Loading...",
    email: "loading@example.com",
    avatar: ""
  })

  // Fetch user data
  useEffect(() => {
    const fetchUserData = async () => {
      const supabase = createClient()
      const { data } = await supabase.auth.getUser()
      
      if (data.user) {
        setUser({
          name: data.user.user_metadata?.name || data.user.email?.split('@')[0] || 'User',
          email: data.user.email || '',
          avatar: data.user.user_metadata?.avatar_url || ''
        })
      }
    }

    fetchUserData()
  }, [])

  // Handle keyboard shortcuts (CMD+B) for consistency
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'b') {
        event.preventDefault();
        // We'll handle this in the parent page component
        // to ensure proper coordination between panels
        setOpen(!state.startsWith('expanded'));
        
        // Broadcast a custom event to notify other components
        window.dispatchEvent(new CustomEvent('sidebar-left-toggled', {
          detail: { expanded: !state.startsWith('expanded') }
        }));
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [state, setOpen]);

  return (
    <Sidebar collapsible="icon" className="border-r-0 bg-background/95 backdrop-blur-sm [&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:'none']" {...props}>
      <SidebarHeader className="px-2 py-2">
        <div className="flex h-[40px] items-center px-1 relative">
          <Link href="/dashboard">
            <KortixLogo />
          </Link>
          {state !== "collapsed" && (
            <div className="ml-2 transition-all duration-200 ease-in-out whitespace-nowrap">
              {/* <span className="font-semibold"> SUNA</span> */}
            </div>
          )}
          <div className="ml-auto flex items-center gap-2">
            {state !== "collapsed" && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <SidebarTrigger className="h-8 w-8" />
                </TooltipTrigger>
                <TooltipContent>Toggle sidebar (CMD+B)</TooltipContent>
              </Tooltip>
            )}
            {isMobile && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => setOpenMobile(true)}
                    className="h-8 w-8 flex items-center justify-center rounded-md hover:bg-accent"
                  >
                    <Menu className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Open menu</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent className="[&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:'none']">
        <NavAgents />
      </SidebarContent>
      {state !== "collapsed" && (
        <div className="px-3 py-2">
          <CTACard />
        </div>
      )}
      <SidebarFooter>
      {state === "collapsed" && (
          <div className="mt-2 flex justify-center">
            <Tooltip>
              <TooltipTrigger asChild>
                <SidebarTrigger className="h-8 w-8" />
              </TooltipTrigger>
              <TooltipContent>Expand sidebar (CMD+B)</TooltipContent>
            </Tooltip>
          </div>
        )}        
        <NavUserWithTeams user={user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
