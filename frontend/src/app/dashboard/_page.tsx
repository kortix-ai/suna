"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import { AppSidebar } from "@/components/dashboard/sidebar/app-sidebar"
import { NavActions } from "@/components/dashboard/sidebar/nav-actions"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb"
import { Separator } from "@/components/ui/separator"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"

export default function Page() {
  const router = useRouter()
  const [currentTeamId, setCurrentTeamId] = useState<string>()

  const handleTeamSelected = (team: any) => {
    setCurrentTeamId(team.account_id)
    // Navigate to the team dashboard if it has a slug
    if (team.slug) {
      router.push(`/dashboard/${team.slug}`)
    }
  }

  return (
    <SidebarProvider>
      <AppSidebar 
        teamId={currentTeamId} 
        onTeamSelected={handleTeamSelected} 
      />
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-2">
          <div className="flex flex-1 items-center gap-2 px-3">
            <SidebarTrigger />
            <Separator
              orientation="vertical"
              className="mr-2 data-[orientation=vertical]:h-4"
            />
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbPage className="line-clamp-1">
                    Project Management & Task Tracking
                  </BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          </div>
          <div className="ml-auto px-3">
            <NavActions />
          </div>
        </header>
        <div className="flex flex-1 flex-col gap-4 px-4 py-10">
          <div className="bg-muted/50 mx-auto h-24 w-full max-w-3xl rounded-xl" />
          <div className="bg-muted/50 mx-auto h-full w-full max-w-3xl rounded-xl" />
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
