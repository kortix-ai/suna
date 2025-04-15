import { SidebarLeft } from "@/components/dashboard/sidebar/sidebar-left"
import { SidebarRight } from "@/components/dashboard/sidebar/sidebar-right"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
interface DashboardLayoutProps {
  children: React.ReactNode
}

export default async function DashboardLayout({
  children,
}: DashboardLayoutProps) {

  return (
    <SidebarProvider>
      <SidebarLeft />
      <SidebarInset>
        {children}
      </SidebarInset>
      {/* <SidebarRight /> */}
    </SidebarProvider>
  )
} 