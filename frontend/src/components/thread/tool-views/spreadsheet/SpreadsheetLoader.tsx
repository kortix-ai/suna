import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

interface SpreadsheetLoaderProps {
  mode?: 'mini' | 'max';
}

export function SpreadsheetLoader({ mode = 'max' }: SpreadsheetLoaderProps) {
  if (mode === 'mini') {
    return (
      <div className="flex items-center justify-center h-full w-full min-h-[200px]">
        <div className="flex flex-col items-center gap-4">
          <div className="grid grid-cols-3 gap-2">
            {[...Array(9)].map((_, i) => (
              <Skeleton key={i} className="h-8 w-16" />
            ))}
          </div>
          <p className="text-sm text-muted-foreground">Loading spreadsheet...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full p-4 bg-background">
      <div className="space-y-2">
        <div className="flex gap-2 mb-4">
          <Skeleton className="h-8 w-full max-w-[600px]" />
          <Skeleton className="h-8 w-32" />
        </div>

        <div className="flex gap-2 pb-2 border-b">
          {[...Array(6)].map((_, i) => (
            <Skeleton key={i} className="h-7 w-16" />
          ))}
        </div>

        <div className="grid gap-0 border rounded-lg overflow-hidden">
          <div className="grid grid-cols-[40px_repeat(10,minmax(80px,1fr))] border-b bg-muted/30">
            <Skeleton className="h-8 w-full rounded-none border-r" />
            {[...Array(10)].map((_, i) => (
              <Skeleton 
                key={i} 
                className={cn(
                  "h-8 w-full rounded-none",
                  i < 9 && "border-r"
                )} 
              />
            ))}
          </div>

          {[...Array(12)].map((_, rowIndex) => (
            <div 
              key={rowIndex} 
              className={cn(
                "grid grid-cols-[40px_repeat(10,minmax(80px,1fr))]",
                rowIndex < 11 && "border-b"
              )}
            >
              <Skeleton className="h-10 w-full rounded-none border-r bg-muted/20" />
              {[...Array(10)].map((_, colIndex) => (
                <Skeleton 
                  key={colIndex} 
                  className={cn(
                    "h-10 w-full rounded-none bg-muted/10",
                    colIndex < 9 && "border-r"
                  )} 
                />
              ))}
            </div>
          ))}
        </div>

        <div className="flex gap-2 pt-2">
          <Skeleton className="h-6 w-20" />
          <Skeleton className="h-6 w-20" />
          <Skeleton className="h-6 w-20" />
        </div>
      </div>
    </div>
  );
}

