"use client"

import * as React from "react"
import { usePathname } from "next/navigation"
import Link from "next/link"
import { Search, Coins, MessageCircle, HelpCircle } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { SpotlightCard } from "@/components/ui/spotlight-card"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import { ThemeToggle } from "../home/theme-toggle"
import { KortixLogo } from "../sidebar/kortix-logo"

const helpData = {
  navMain: [
    {
      title: "Billing & Usage",
      items: [
        {
          title: "What are Credits?",
          url: "/credits-explained",
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

interface HelpSidebarProps extends React.ComponentProps<typeof Sidebar> {
  onSearchClick?: () => void;
}

export function HelpSidebar({ onSearchClick, ...props }: HelpSidebarProps) {
  const pathname = usePathname()

  const isActive = (url: string) => {
    return pathname === url
  }

  return (
    <Sidebar className="w-72 [&_[data-sidebar=sidebar]]:bg-background dark:[&_[data-sidebar=sidebar]]:bg-background border-none" {...props}>
      <SidebarHeader className="bg-transparent p-6 px-6 space-y-3">
        <KortixLogo size={24} />
        {onSearchClick && (
          <Button
            variant="outline"
            className="w-full justify-between h-12 text-muted-foreground"
            onClick={onSearchClick}
          >
            <div className="flex items-center gap-2">
              <Search className="h-4 w-4" />
              <span className="text-sm">Search help</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="h-7 w-7 flex items-center justify-center text-sm text-muted-foreground bg-muted rounded-lg">
                ⌘
              </div>
              <div className="h-7 w-7 flex items-center justify-center text-sm text-muted-foreground bg-muted rounded-lg">
                K
              </div>
            </div>
          </Button>
        )}
      </SidebarHeader>
      <SidebarContent className="px-2 bg-transparent scrollbar-thin scrollbar-thumb-primary/20 scrollbar-track-transparent">
        {helpData.navMain.map((section) => (
          <SidebarGroup key={section.title}>
            <SidebarGroupLabel className="font-medium tracking-wide ml-1">{section.title}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {section.items.map((item) => {
                  const active = isActive(item.url);
                  return (
                    <SidebarMenuItem key={item.title}>
                      <SpotlightCard
                        className={cn(
                          "transition-colors cursor-pointer h-10 flex items-center",
                          active ? "bg-muted" : "bg-transparent"
                        )}
                      >
                        {item.external ? (
                          <a 
                            href={item.url} 
                            target="_blank" 
                            rel="noopener noreferrer" 
                            className={cn(
                              "flex items-center justify-between w-full px-3 py-2 text-sm",
                              active ? "text-foreground" : "text-muted-foreground"
                            )}
                          >
                            <span className="font-medium text-primary">{item.title}</span>
                          </a>
                        ) : (
                          <Link 
                            href={item.url} 
                            className={cn(
                              "flex items-center justify-between w-full px-3 py-2 text-sm",
                              active ? "text-foreground" : "text-muted-foreground"
                            )}
                          >
                            <span className="font-medium text-primary">{item.title}</span>
                          </Link>
                        )}
                      </SpotlightCard>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter className="bg-transparent p-4 flex flex-row justify-between items-center">
        <div className="text-muted-foreground text-xs">Version 0.1.0</div>
        <ThemeToggle />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

