"use client"

import * as React from "react"
import { usePathname } from "next/navigation"
import Link from "next/link"
import {
  GalleryVerticalEnd,
} from "lucide-react"

import { TeamSwitcher } from "@/components/team-switcher"
import { NavUser } from "@/components/nav-user"
import { DocsThemeToggle } from "@/components/ui/docs-theme-toggle"
import { Badge } from "@/components/ui/badge"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import { ThemeToggle } from "./home/theme-toggle"
import { KortixLogo } from "./sidebar/kortix-logo"
import Image from "next/image"
import { useEffect } from "react"
import { useTheme } from "next-themes"

const data = {
  user: {
    name: "Kortix User",
    email: "docs@kortix.ai",
    avatar: "/favicon.png",
  },
  teams: [
    {
      name: "Kortix AI",
      logo: GalleryVerticalEnd,
      plan: "Open Source",
    },
  ],
  navMain: [
    {
      title: "Getting Started",
      items: [
        {
          title: "What is Kortix?",
          url: "/docs/introduction",
        },
        {
          title: "Self Hosting",
          url: "/docs/self-hosting",
        },
        {
          title: "Agent Examples",
          url: "/docs/agent-examples",
          comingSoon: true,
        },
      ],
    },
    {
      title: "Contributing",
      items: [
        {
          title: "Contributing Guide",
          url: "/docs/contributing",
        },
        {
          title: "License",
          url: "/docs/license",
        },
      ],
    },
    {
      title: "Quick Links",
      items: [
        {
          title: "GitHub Repository",
          url: "https://github.com/kortix-ai/suna",
          external: true,
        },
        {
          title: "Discord Community",
          url: "https://discord.gg/Py6pCBUUPw",
          external: true,
        },
      ],
    },
  ],
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const pathname = usePathname()
  const [mounted, setMounted] = React.useState(false);
  const { theme, resolvedTheme } = useTheme();

  useEffect(() => {
    setMounted(true);
  }, []);

  const logoSrc = !mounted
    ? '/kortix-logo.svg'
    : resolvedTheme === 'dark'
      ? '/kortix-logo-white.svg'
      : '/kortix-logo.svg';
  

  const isActive = (url: string) => {
    return pathname === url
  }

  return (
    <Sidebar className="w-72 [&_[data-sidebar=sidebar]]:bg-white dark:[&_[data-sidebar=sidebar]]:bg-black border-none" {...props}>
      <SidebarHeader className="bg-transparent p-6 px-2">
        <Image
          src={logoSrc}
          alt="Kortix Logo"
          width={80}
          height={14}
          className="md:w-[100px] md:h-[18px]"
          priority
        /> 
      </SidebarHeader>
      <SidebarContent className="px-2 bg-transparent scrollbar-thin scrollbar-thumb-primary/20 scrollbar-track-transparent">
        {data.navMain.map((section) => (
          <SidebarGroup key={section.title}>
            <SidebarGroupLabel className="font-medium tracking-wide">{section.title}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {section.items.map((item) => (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton 
                      className={`font-semibold ${item.comingSoon ? 'opacity-70 cursor-not-allowed' : ''}`}
                      asChild={!item.comingSoon}
                      isActive={isActive(item.url)}
                      disabled={item.comingSoon}
                    >
                      {item.comingSoon ? (
                        <div className="flex items-center justify-between w-full">
                          <span>{item.title}</span>
                          <Badge className="ml-auto text-xs bg-amber-500/20 border-amber-500/60 text-white text-amber-500">
                            Coming Soon
                          </Badge>
                        </div>
                      ) : item.external ? (
                        <a href={item.url} target="_blank" rel="noopener noreferrer" className="flex items-center justify-between w-full">
                          <span>{item.title}</span>
                        </a>
                      ) : (
                        <Link href={item.url} className="flex items-center justify-between w-full">
                          <span>{item.title}</span>
                        </Link>
                      )}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter className="bg-transparent p-4 flex flex-row justify-between items-center">
        <div className="text-muted-foreground text-xs">Version 0.1.0</div>
        <ThemeToggle/>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

