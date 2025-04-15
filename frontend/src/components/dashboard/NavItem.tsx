"use client";
import Link from "next/link";
import React from "react";

interface NavItemProps {
  icon: React.ReactNode;
  label: string;
  href: string;
  isCollapsed: boolean;
  hideIconWhenCollapsed?: boolean;
}

export default function NavItem({
  icon,
  label,
  href,
  isCollapsed,
  hideIconWhenCollapsed = false
}: NavItemProps) {
  return (
    <Link
      href={href}
      className={`flex items-center gap-2 py-1.5 px-2 hover:bg-hover-bg transition-all duration-200 group text-sm ${
        isCollapsed ? "justify-center" : ""
      }`}
    >
      {(!isCollapsed || !hideIconWhenCollapsed) && (
        <div className="text-icon-color flex-shrink-0">
          {icon}
        </div>
      )}
      {!isCollapsed && <span className="text-foreground/90 truncate">{label}</span>}
      {isCollapsed && !hideIconWhenCollapsed && (
        <div className="absolute left-full ml-2 scale-0 group-hover:scale-100 transition-all duration-200 origin-left z-50">
          <div className="bg-background p-2 shadow-custom border border-subtle dark:border-white/10">
            <span className="whitespace-nowrap text-foreground text-xs">{label}</span>
          </div>
        </div>
      )}
    </Link>
  );
} 