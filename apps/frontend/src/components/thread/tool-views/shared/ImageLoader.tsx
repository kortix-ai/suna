import { Skeleton } from "@/components/ui/skeleton"

export const ImageLoader = ({ className = "" } : {className?: string}) => {
    return (
      <div className={`relative flex items-center justify-center h-full w-full overflow-hidden ${className}`}>
        <div className="h-[60%] flex flex-col gap-6 aspect-square rounded-xl items-center justify-center">
            <Skeleton className="w-full h-full rounded-lg" />
            <Skeleton className="w-full h-14 rounded-lg" />
            <Skeleton className="w-full h-14 rounded-lg" />
        </div>
      </div>
    )
}