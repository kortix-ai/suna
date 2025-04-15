"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { ChevronDown, Plus, Command, AudioWaveform } from "lucide-react"
import { useAccounts } from "@/hooks/use-accounts"
import NewTeamForm from "@/components/basejump/new-team-form"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"

export function TeamSwitcher() {
  const router = useRouter()
  const { data: accounts } = useAccounts()
  const [showNewTeamDialog, setShowNewTeamDialog] = React.useState(false)
  
  // Prepare personal account and team accounts
  const personalAccount = React.useMemo(() => accounts?.find(account => account.personal_account), [accounts])
  const teamAccounts = React.useMemo(() => accounts?.filter(account => !account.personal_account), [accounts])
  
  // Create a default list of teams with logos for the UI (will show until real data loads)
  const defaultTeams = [
    {
      name: personalAccount?.name || "Personal Account",
      logo: Command,
      plan: "Personal",
      account_id: personalAccount?.account_id,
      slug: personalAccount?.slug,
      personal_account: true
    },
    ...(teamAccounts?.map(team => ({
      name: team.name,
      logo: AudioWaveform,
      plan: "Team",
      account_id: team.account_id,
      slug: team.slug,
      personal_account: false
    })) || [])
  ]
  
  // Use the first team or first entry in defaultTeams as activeTeam
  const [activeTeam, setActiveTeam] = React.useState(defaultTeams[0])
  
  // Update active team when accounts load
  React.useEffect(() => {
    if (accounts?.length) {
      const currentTeam = accounts.find(account => account.account_id === activeTeam.account_id)
      if (currentTeam) {
        setActiveTeam({
          name: currentTeam.name,
          logo: currentTeam.personal_account ? Command : AudioWaveform,
          plan: currentTeam.personal_account ? "Personal" : "Team",
          account_id: currentTeam.account_id,
          slug: currentTeam.slug,
          personal_account: currentTeam.personal_account
        })
      } else {
        // If current team not found, set first available account as active
        const firstAccount = accounts[0]
        setActiveTeam({
          name: firstAccount.name,
          logo: firstAccount.personal_account ? Command : AudioWaveform,
          plan: firstAccount.personal_account ? "Personal" : "Team",
          account_id: firstAccount.account_id,
          slug: firstAccount.slug,
          personal_account: firstAccount.personal_account
        })
      }
    }
  }, [accounts, activeTeam.account_id])
  
  // Handle team selection
  const handleTeamSelect = (team) => {
    setActiveTeam(team)
    
    // Navigate to the appropriate dashboard
    if (team.personal_account) {
      router.push('/dashboard')
    } else {
      router.push(`/dashboard/${team.slug}`)
    }
  }

  if (!activeTeam) {
    return null
  }

  return (
    <Dialog open={showNewTeamDialog} onOpenChange={setShowNewTeamDialog}>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton className="w-fit px-1.5">
                <div className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-5 items-center justify-center rounded-md">
                  <activeTeam.logo className="size-3" />
                </div>
                <span className="truncate font-medium">{activeTeam.name}</span>
                <ChevronDown className="opacity-50" />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="w-64 rounded-lg"
              align="start"
              side="bottom"
              sideOffset={4}
            >
              {personalAccount && (
                <>
                  <DropdownMenuLabel className="text-muted-foreground text-xs">
                    Personal Account
                  </DropdownMenuLabel>
                  <DropdownMenuItem
                    key={personalAccount.account_id}
                    onClick={() => handleTeamSelect({
                      name: personalAccount.name,
                      logo: Command,
                      plan: "Personal",
                      account_id: personalAccount.account_id,
                      slug: personalAccount.slug,
                      personal_account: true
                    })}
                    className="gap-2 p-2"
                  >
                    <div className="flex size-6 items-center justify-center rounded-xs border">
                      <Command className="size-4 shrink-0" />
                    </div>
                    {personalAccount.name}
                    <DropdownMenuShortcut>⌘1</DropdownMenuShortcut>
                  </DropdownMenuItem>
                </>
              )}
              
              {teamAccounts?.length > 0 && (
                <>
                  <DropdownMenuLabel className="text-muted-foreground text-xs mt-2">
                    Teams
                  </DropdownMenuLabel>
                  {teamAccounts.map((team, index) => (
                    <DropdownMenuItem
                      key={team.account_id}
                      onClick={() => handleTeamSelect({
                        name: team.name,
                        logo: AudioWaveform,
                        plan: "Team",
                        account_id: team.account_id,
                        slug: team.slug,
                        personal_account: false
                      })}
                      className="gap-2 p-2"
                    >
                      <div className="flex size-6 items-center justify-center rounded-xs border">
                        <AudioWaveform className="size-4 shrink-0" />
                      </div>
                      {team.name}
                      <DropdownMenuShortcut>⌘{index + 2}</DropdownMenuShortcut>
                    </DropdownMenuItem>
                  ))}
                </>
              )}
              
              <DropdownMenuSeparator />
              <DialogTrigger asChild>
                <DropdownMenuItem 
                  className="gap-2 p-2"
                  onClick={() => {
                    setShowNewTeamDialog(true)
                  }}
                >
                  <div className="bg-background flex size-6 items-center justify-center rounded-md border">
                    <Plus className="size-4" />
                  </div>
                  <div className="text-muted-foreground font-medium">Add team</div>
                </DropdownMenuItem>
              </DialogTrigger>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>
      
      <DialogContent className="sm:max-w-[425px] border-subtle dark:border-white/10 bg-card-bg dark:bg-background-secondary rounded-2xl shadow-custom">
        <DialogHeader>
          <DialogTitle className="text-foreground">Create a new team</DialogTitle>
          <DialogDescription className="text-foreground/70">
            Create a team to collaborate with others.
          </DialogDescription>
        </DialogHeader>
        <NewTeamForm />
      </DialogContent>
    </Dialog>
  )
}
