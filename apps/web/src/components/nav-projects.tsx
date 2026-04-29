"use client"

import Link from "next/link"
import {
  Folder,
  Forward,
  MoreHorizontal,
  Trash2,
} from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"

export type NavProjectItem = {
  id: string
  name: string
  url: string
  isActive?: boolean
  /** Custom leading element — usually a colored project avatar/icon. */
  leading?: React.ReactNode
  onView?: () => void
  onShare?: () => void
  onDelete?: () => void
}

export function NavProjects({
  projects,
  label = "Projects",
  emptyState,
  footer,
}: {
  projects: NavProjectItem[]
  label?: string
  emptyState?: React.ReactNode
  footer?: React.ReactNode
}) {
  const { isMobile } = useSidebar()

  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarMenu>
        {projects.length === 0 && emptyState && (
          <SidebarMenuItem>
            <div className="px-2 py-1.5 text-xs text-muted-foreground/65">
              {emptyState}
            </div>
          </SidebarMenuItem>
        )}

        {projects.map((item) => (
          <SidebarMenuItem key={item.id}>
            <SidebarMenuButton asChild isActive={item.isActive} className="font-medium text-primary">
              <Link href={item.url}>
                {item.leading ?? <Folder />}
                <span className="truncate">{item.name}</span>
              </Link>
            </SidebarMenuButton>
            {(item.onView || item.onShare || item.onDelete) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuAction showOnHover>
                    <MoreHorizontal />
                    <span className="sr-only">More</span>
                  </SidebarMenuAction>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  className="w-48 rounded-lg"
                  side={isMobile ? "bottom" : "right"}
                  align={isMobile ? "end" : "start"}
                >
                  {item.onView && (
                    <DropdownMenuItem onClick={item.onView}>
                      <Folder className="text-muted-foreground" />
                      <span>View project</span>
                    </DropdownMenuItem>
                  )}
                  {item.onShare && (
                    <DropdownMenuItem onClick={item.onShare}>
                      <Forward className="text-muted-foreground" />
                      <span>Share project</span>
                    </DropdownMenuItem>
                  )}
                  {item.onDelete && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={item.onDelete}
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2 />
                        <span>Delete project</span>
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </SidebarMenuItem>
        ))}

        {footer && <SidebarMenuItem>{footer}</SidebarMenuItem>}
      </SidebarMenu>
    </SidebarGroup>
  )
}
