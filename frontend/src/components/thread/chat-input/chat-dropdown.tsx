import React, { useState } from 'react'
import { ChevronDown, User, LogIn, Lock, Bot, Zap, Code, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

const ChatDropdown = () => {
    const [isOpen, setIsOpen] = useState(false)

    return (
        <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="ghost"
                    size="sm"
                    className="px-3 py-2 text-sm font-medium hover:bg-accent"
                    style={{
                        borderRadius: '12px'
                    }}
                >
                    <div className="flex items-center gap-2">
                        <User size={16} />
                        <span>Suna</span>
                        <ChevronDown size={14} className="opacity-50" />
                    </div>
                </Button>
            </DropdownMenuTrigger>

            <DropdownMenuContent
                align="end"
                className="w-64 p-0 border"
                sideOffset={4}
            >
                <DropdownMenuItem
                    className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-accent border-b m-0"
                    style={{
                        borderRadius: '0'
                    }}
                >
                    <User size={18} />
                    <div className="flex flex-col">
                        <span className="font-semibold text-sm">Suna</span>
                        <span className="text-xs text-muted-foreground">Default</span>
                    </div>
                </DropdownMenuItem>

                <div className="relative">
                    {/* Dummy agents behind the overlay */}
                    <DropdownMenuItem className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-accent border-b m-0">
                        <Bot size={18} />
                        <div className="flex flex-col">
                            <span className="font-semibold text-sm">Code Assistant</span>
                            <span className="text-xs text-muted-foreground">Help with coding</span>
                        </div>
                    </DropdownMenuItem>

                    <DropdownMenuItem className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-accent border-b m-0">
                        <Zap size={18} />
                        <div className="flex flex-col">
                            <span className="font-semibold text-sm">Quick Writer</span>
                            <span className="text-xs text-muted-foreground">Fast content creation</span>
                        </div>
                    </DropdownMenuItem>

                    <DropdownMenuItem className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-accent m-0">
                        <FileText size={18} />
                        <div className="flex flex-col">
                            <span className="font-semibold text-sm">Document Helper</span>
                            <span className="text-xs text-muted-foreground">Analyze documents</span>
                        </div>
                    </DropdownMenuItem>

                    {/* Overlay like the upgrade component */}
                    <div className="absolute inset-0 bg-gradient-to-t from-background via-background/95 to-transparent flex items-end justify-center">
                        <div className="w-full p-3">
                            <div className="rounded-xl bg-gradient-to-br from-slate-50/80 to-slate-100/70 dark:from-slate-900/40 dark:to-slate-800/30 shadow-sm border border-slate-200/50 dark:border-slate-700/50 p-3">
                                <div className="flex items-center justify-center">
                                    <Lock className="h-4 w-4 text-slate-500 mr-2 flex-shrink-0" />
                                    <p className="text-sm font-medium">Login to explore all agents</p>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </DropdownMenuContent>
        </DropdownMenu>
    )
}

export default ChatDropdown