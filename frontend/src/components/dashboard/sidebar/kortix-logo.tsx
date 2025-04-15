"use client"

import Image from "next/image"
import { useSidebar } from "@/components/ui/sidebar"

export function KortixLogo() {
  const { state } = useSidebar()
  
  return (
    <div className="flex items-center">
      <Image
        src="/kortix-symbol.svg"
        alt="Kortix"
        width={24}
        height={24}
        className="transition-all duration-200"
      />
    </div>
  )
} 