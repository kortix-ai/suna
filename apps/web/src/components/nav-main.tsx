"use client"

import Link from "next/link"
import { ChevronRight, type LucideIcon } from "lucide-react"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Kbd } from "@/components/ui/kbd"
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar"

export type NavMainItem = {
  title: string
  url?: string
  icon?: LucideIcon
  isActive?: boolean
  shortcut?: string
  onAction?: () => void
  items?: {
    title: string
    url: string
    isActive?: boolean
    leading?: React.ReactNode
  }[]
  renderContent?: () => React.ReactNode
}

export function NavMain({
  items,
  label = "Platform",
}: {
  items: NavMainItem[]
  label?: string
}) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) => {
          const hasSubItems = !!item.items?.length
          const hasCustomContent = !!item.renderContent
          const isCollapsible = hasSubItems || hasCustomContent

          if (!isCollapsible) {
            return (
              <SidebarMenuItem key={item.title}>
                <SidebarMenuButton
                  tooltip={item.shortcut ? `${item.title} ${item.shortcut}` : item.title}
                  isActive={item.isActive}
                  asChild={!!item.url}
                  onClick={item.onAction}
                  className="font-medium text-primary"
                >
                  {item.url ? (
                    <Link href={item.url}>
                      {item.icon && <item.icon className="text-muted-foreground/50" />}
                      <span>{item.title}</span>
                      {item.shortcut && (
                        <Kbd className="ml-auto bg-transparent text-muted-foreground/55 group-data-[collapsible=icon]:hidden">
                          {item.shortcut}
                        </Kbd>
                      )}
                    </Link>
                  ) : (
                    <>
                      {item.icon && <item.icon className="text-muted-foreground/50" />}
                      <span>{item.title}</span>
                      {item.shortcut && (
                        <Kbd className="ml-auto bg-transparent text-muted-foreground/55 group-data-[collapsible=icon]:hidden">
                          {item.shortcut}
                        </Kbd>
                      )}
                    </>
                  )}
                </SidebarMenuButton>
              </SidebarMenuItem>
            )
          }

          return (
            <Collapsible
              key={item.title}
              asChild
              defaultOpen={item.isActive}
              className="group/collapsible"
            >
              <SidebarMenuItem>
                <CollapsibleTrigger asChild>
                  <SidebarMenuButton tooltip={item.title}>
                    {item.icon && <item.icon className="text-muted-foreground/50" />}
                    <span className="font-medium text-primary">{item.title}</span>
                    <ChevronRight className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
                  </SidebarMenuButton>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  {hasCustomContent ? (
                    item.renderContent!()
                  ) : (
                    <SidebarMenuSub>
                      {item.items?.map((subItem) => (
                        <SidebarMenuSubItem key={subItem.title}>
                          <SidebarMenuSubButton asChild isActive={subItem.isActive}>
                            <Link href={subItem.url}>
                              {subItem.leading}
                              <span className="truncate">{subItem.title}</span>
                            </Link>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      ))}
                    </SidebarMenuSub>
                  )}
                </CollapsibleContent>
              </SidebarMenuItem>
            </Collapsible>
          )
        })}
      </SidebarMenu>
    </SidebarGroup>
  )
}
