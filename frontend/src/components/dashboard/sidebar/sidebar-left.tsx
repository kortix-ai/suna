"use client"

import * as React from "react"
import {
  BookOpen,
  CalendarClock,
} from "lucide-react"
import Link from "next/link"

import { NavAgents } from "@/components/dashboard/sidebar/nav-agents"
import { NavUserWithTeams } from "@/components/dashboard/sidebar/nav-user-with-teams"
import { NavSecondary } from "@/components/dashboard/sidebar/nav-secondary"
import { KortixLogo } from "@/components/dashboard/sidebar/kortix-logo"
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

// Only keep necessary data
const navSecondaryItems = [
  {
    title: "Hiring!",
    url: "https://www.kortix.ai/careers",
    icon: BookOpen,
  },
  {
    title: "Book Enterprise Demo",
    url: "https://cal.com/marko-kraemer/15min",
    icon: CalendarClock,
  },
]

export function SidebarLeft({
  ...props
}: React.ComponentProps<typeof Sidebar>) {
  const { state } = useSidebar()
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

  return (
    <Sidebar collapsible="icon" className="border-r-0 bg-background/95 backdrop-blur-sm" {...props}>
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
          {state !== "collapsed" && (
            <div className="ml-auto">
              <Tooltip>
                <TooltipTrigger asChild>
                  <SidebarTrigger className="h-8 w-8" />
                </TooltipTrigger>
                <TooltipContent>Toggle sidebar</TooltipContent>
              </Tooltip>
            </div>
          )}
        </div>
      </SidebarHeader>
      <SidebarContent>
        <NavAgents />
        <NavSecondary items={navSecondaryItems} className="mt-auto" />
        {state === "collapsed" && (
          <div className="mt-2 flex justify-center">
            <Tooltip>
              <TooltipTrigger asChild>
                <SidebarTrigger className="h-8 w-8" />
              </TooltipTrigger>
              <TooltipContent>Expand sidebar</TooltipContent>
            </Tooltip>
          </div>
        )}
      </SidebarContent>
      <SidebarFooter>
        <NavUserWithTeams user={user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
