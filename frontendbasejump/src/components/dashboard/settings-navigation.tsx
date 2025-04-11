"use client"

import Link from "next/link"
import {usePathname} from "next/navigation"

import {cn} from "@/lib/utils"
import {buttonVariants} from "@/components/ui/button"

interface SidebarNavProps extends React.HTMLAttributes<HTMLElement> {
    items: {
        href: string
        name: string
    }[]
}

export default function SettingsNavigation({ className, items, ...props }: SidebarNavProps) {
    const pathname = usePathname()

    return (
        <nav
            className={cn(
                "flex space-x-2 lg:flex-col lg:space-x-0 lg:space-y-1",
                className
            )}
            {...props}
        >
            {items.map((item) => (
                <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                        buttonVariants({ variant: "ghost" }),
                        pathname === item.href
                            ? "bg-hover-bg dark:bg-hover-bg-dark text-card-title"
                            : "text-foreground/70 hover:bg-hover-bg dark:hover:bg-hover-bg-dark hover:text-card-title",
                        "justify-start rounded-lg h-10"
                    )}
                >
                    {item.name}
                </Link>
            ))}
        </nav>
    )
}
