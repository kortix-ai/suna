"use client"

import { SidebarLeft } from "@/components/dashboard/sidebar/sidebar-left"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb"
import { Separator } from "@/components/ui/separator"
import { Button } from "@/components/ui/button"
import { Copy } from "lucide-react"
import { usePathname } from "next/navigation"
import { toast } from "sonner"

interface DashboardLayoutProps {
  children: React.ReactNode
}

export default function DashboardLayout({
  children,
}: DashboardLayoutProps) {
  const pathname = usePathname()
  
  const copyCurrentUrl = () => {
    const url = window.location.origin + pathname
    navigator.clipboard.writeText(url)
    toast.success("URL copied to clipboard")
  }

  return (
    <SidebarProvider>
      <SidebarLeft  />
      <SidebarInset>
        <header className="bg-background sticky top-0 flex h-14 shrink-0 items-center gap-2">
          <div className="flex flex-1 items-center gap-2 px-3">
            <SidebarTrigger />
          </div>
          
          <div className="absolute left-1/2 -translate-x-1/2 text-sm font-medium tracking-wide uppercase text-muted-foreground">
            Dynamic Page Title
          </div>
          
          <div className="flex items-center pr-4">
            <Button
              variant="ghost"
              size="icon"
              onClick={copyCurrentUrl}
              className="h-9 w-9"
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
        </header>
        <div className="bg-background">
          {children}
        </div>
      </SidebarInset>
      {/* <SidebarRight /> */}
    </SidebarProvider>
  )
} 