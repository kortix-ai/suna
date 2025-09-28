'use client';

import { cn } from "@/lib/utils";
import { ShinyText } from "../ui/shiny-text";
import { ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";

interface ReleaseBadgeProps {
    text: string;
    link?: string;
    className?: string;
}
export const ReleaseBadge = ({ text, link, className }: ReleaseBadgeProps) => {
    const router = useRouter();
  return (
    <div className="z-10 flex items-center justify-center px-2 sm:px-0">
      <div
        onClick={() => link && router.push(link)}
        className={cn(
          "group rounded-full border border-black/5 bg-neutral-100 text-base text-white transition-all ease-in hover:bg-neutral-200 dark:border-white/5 dark:bg-neutral-900 dark:hover:bg-neutral-800 active:scale-95 touch-manipulation max-w-[calc(100vw-2rem)] sm:max-w-none",
          className
        )}
      >
        <ShinyText className="text-xs sm:text-sm inline-flex items-center justify-center px-3 py-2 sm:px-4 sm:py-1 transition ease-out hover:text-neutral-600 hover:duration-300 hover:dark:text-neutral-400 min-h-[44px] sm:min-h-auto">
          <span className="text-blue-500 font-semibold mr-1.5 sm:mr-2 shrink-0">New!</span>
          <span className="truncate sm:text-clip leading-tight">{text}</span>
          <ArrowRight className="ml-1 sm:ml-1 size-3 sm:size-3 transition-transform duration-300 ease-in-out group-hover:translate-x-0.5 shrink-0" />
        </ShinyText>
      </div>
    </div>
  );
};