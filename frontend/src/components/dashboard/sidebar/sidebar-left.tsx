"use client"

import * as React from "react"
import {
  BookOpen,
  CalendarClock,
  HelpCircle,
  MessageCircleQuestion,
} from "lucide-react"

import { NavAgents } from "@/components/dashboard/sidebar/nav-agents"
import { NavUser } from "@/components/dashboard/sidebar/nav-user"
import { NavSecondary } from "@/components/dashboard/sidebar/nav-secondary"
import { TeamSwitcher } from "@/components/dashboard/sidebar/team-switcher"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from "@/components/ui/sidebar"
import { useEffect, useState } from "react"
import { createClient } from "@/lib/supabase/client"

// Only keep necessary data
const navSecondaryItems = [
  {
    title: "Help",
    url: "#",
    icon: HelpCircle,
  },
  {
    title: "Careers",
    url: "#",
    icon: BookOpen,
  },
  {
    title: "Book Demo",
    url: "#",
    icon: CalendarClock,
  },
]

export function SidebarLeft({
  ...props
}: React.ComponentProps<typeof Sidebar>) {
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
    <Sidebar className="border-r-0" {...props}>
      <SidebarHeader>
        <TeamSwitcher />
      </SidebarHeader>
      <SidebarContent>
        <NavAgents />
        <NavSecondary items={navSecondaryItems} className="mt-auto" />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
