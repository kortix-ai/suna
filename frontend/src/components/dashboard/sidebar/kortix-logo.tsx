"use client"

import Image from "next/image"
import { useSidebar } from "@/components/ui/sidebar"
import { useTheme } from "next-themes"
import { useEffect, useState } from "react"

export function KortixLogo() {
  const { state } = useSidebar()
  const { theme } = useTheme()
  const [mounted, setMounted] = useState(false)
  
  // After mount, we can access the theme
  useEffect(() => {
    setMounted(true)
  }, [])
  
  return (
    <div className="flex items-center">
      <Image
        src="/kortix-symbol.svg"
        alt="Kortix"
        width={24}
        height={24}
        className={`${mounted && theme === 'dark' ? 'invert' : ''}`}
      />
    </div>
  )
} 