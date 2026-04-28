"use client"

import * as React from "react"
import { useRouter, usePathname } from "next/navigation"
import {
  FolderOpen,
  MessageSquareText,
  Search,
  Sparkles,
} from "lucide-react"

import { NavMain, type NavMainItem } from "@/components/nav-main"
import { NavProjects, type NavProjectItem } from "@/components/nav-projects"
import { NavUser } from "@/components/nav-user"
import { KortixBrand } from "@/components/kortix-brand"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from "@/components/ui/sidebar"
import { ProjectIcon } from "@/components/kortix/project-icon"
import { SessionList } from "@/components/sidebar/session-list"
import {
  getCurrentInstanceIdFromPathname,
  getActiveInstanceIdFromCookie,
  toInstanceAwarePath,
  normalizeAppPathname,
} from "@/lib/instance-routes"
import { useKortixProjects, type KortixProject } from "@/hooks/kortix/use-kortix-projects"
import { useCreateOpenCodeSession } from "@/hooks/opencode/use-opencode-sessions"
import { useDeleteProject } from "@/hooks/kortix/use-kortix-projects"
import { useAdminRole } from "@/hooks/admin"
import { createClient } from "@/lib/supabase/client"
import { toast } from "sonner"

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const pathname = usePathname()
  const router = useRouter()

  const instanceId = React.useMemo(
    () =>
      getCurrentInstanceIdFromPathname(pathname) ||
      getActiveInstanceIdFromCookie(),
    [pathname],
  )
  const normalized = normalizeAppPathname(pathname)
  const buildHref = React.useCallback(
    (href: string) => toInstanceAwarePath(href, instanceId),
    [instanceId],
  )

  const user = useUserDisplay()
  const isMac = useIsMac()

  const openCommandPalette = React.useCallback(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "k",
        code: "KeyK",
        metaKey: isMac,
        ctrlKey: !isMac,
        bubbles: true,
        cancelable: true,
      }),
    )
  }, [isMac])

  const createSession = useCreateOpenCodeSession()
  const handleNewSession = React.useCallback(async () => {
    try {
      const session = await createSession.mutateAsync()
      router.push(buildHref(`/sessions/${session.id}`))
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent("focus-session-textarea"))
      })
    } catch {
      router.push(buildHref("/dashboard"))
    }
  }, [createSession, router, buildHref])

  const { data: projectsData } = useKortixProjects()
  const deleteProject = useDeleteProject()
  const projects = React.useMemo<KortixProject[]>(() => {
    if (!projectsData || !Array.isArray(projectsData)) return []
    return [...projectsData].sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    )
  }, [projectsData])

  const isFilesActive =
    normalized === "/files" || normalized.startsWith("/files/")
  const isSessionsActive =
    normalized === "/sessions" || normalized.startsWith("/sessions/")
  const isProjectsRoute = normalized.startsWith("/projects/")
  const activeProjectId = React.useMemo(() => {
    const m = normalized.match(/^\/projects\/([^/]+)/)
    return m ? decodeURIComponent(m[1]) : null
  }, [normalized])

  const navMain: NavMainItem[] = [
    {
      title: "Search",
      icon: Search,
      shortcut: isMac ? "⌘K" : "Ctrl K",
      onAction: openCommandPalette,
    },
    {
      title: "New chat",
      icon: Sparkles,
      shortcut: isMac ? "⌘J" : "Ctrl J",
      onAction: handleNewSession,
    },
    {
      title: "Files",
      url: buildHref("/files"),
      icon: FolderOpen,
      isActive: isFilesActive,
    },
    {
      title: "Sessions",
      icon: MessageSquareText,
      isActive: isSessionsActive,
      renderContent: () => (
        <div className="max-h-[40vh] overflow-y-auto pl-1 [&::-webkit-scrollbar]:hidden">
          <SessionList projectId={null} />
        </div>
      ),
    },
  ]

  const projectItems: NavProjectItem[] = projects.map((project) => ({
    id: project.id,
    name: project.name,
    url: buildHref(`/projects/${encodeURIComponent(project.id)}`),
    isActive: activeProjectId === project.id,
    leading: <ProjectIcon project={project} size="xs" />,
    onView: () =>
      router.push(buildHref(`/projects/${encodeURIComponent(project.id)}`)),
    onDelete: async () => {
      if (!confirm(`Delete "${project.name}"? This cannot be undone.`)) return
      try {
        await deleteProject.mutateAsync(project.id)
        toast.success(`Deleted ${project.name}`)
        if (isProjectsRoute && activeProjectId === project.id) {
          router.push(buildHref("/dashboard"))
        }
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to delete project",
        )
      }
    },
  }))

  return (
    <Sidebar collapsible="icon" {...props} className="border-r border-sidebar-border/30">
      <SidebarHeader>
        <KortixBrand href={buildHref("/dashboard")} />
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={navMain} />
        <NavProjects
          projects={projectItems}
          emptyState="No projects yet"
        />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

function useUserDisplay() {
  const { data: adminRoleData } = useAdminRole()
  const isAdmin = adminRoleData?.isAdmin ?? false
  const [user, setUser] = React.useState<{
    name: string
    email: string
    avatar: string
  }>({ name: "Loading…", email: "", avatar: "" })

  React.useEffect(() => {
    let cancelled = false
    ;(async () => {
      const supabase = createClient()
      const { data } = await supabase.auth.getUser()
      if (cancelled || !data.user) return
      setUser({
        name:
          data.user.user_metadata?.name ||
          data.user.email?.split("@")[0] ||
          "User",
        email: data.user.email || "",
        avatar:
          data.user.user_metadata?.avatar_url ||
          data.user.user_metadata?.picture ||
          "",
      })
    })()
    return () => {
      cancelled = true
    }
  }, [isAdmin])

  return user
}

function useIsMac() {
  const [isMac, setIsMac] = React.useState(false)
  React.useEffect(() => {
    setIsMac(/Mac/.test(navigator.userAgent))
  }, [])
  return isMac
}
