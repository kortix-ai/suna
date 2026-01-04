import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

interface SpreadsheetLoaderProps {
  mode?: 'mini' | 'max';
}

export function SpreadsheetLoader({ mode = 'max' }: SpreadsheetLoaderProps) {
  if (mode === 'mini') {
    return (
      <div className="flex flex-col h-full w-full min-h-[200px] border rounded-md overflow-hidden bg-background">
        <div className="h-8 border-b bg-muted/20 flex items-center px-2 gap-2">
           <Skeleton className="h-4 w-4 rounded" />
           <Skeleton className="h-4 w-4 rounded" />
           <div className="h-4 w-[1px] bg-border mx-1" />
           <Skeleton className="h-4 w-16 rounded" />
        </div>
        <div className="flex-1 relative">
            <div className="absolute inset-0 grid grid-cols-4 grid-rows-6 gap-[1px] bg-border/50 p-[1px]">
                 {[...Array(24)].map((_, i) => (
                    <div key={i} className="bg-background" />
                 ))}
            </div>
            <div className="absolute inset-0 flex items-center justify-center">
                 <div className="flex flex-col items-center gap-2 bg-background/80 p-4 rounded-lg backdrop-blur-sm shadow-sm">
                    <p className="text-xs font-medium text-muted-foreground animate-pulse">Loading spreadsheet...</p>
                 </div>
            </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full w-full bg-background overflow-hidden animate-in fade-in duration-500">
      <div className="flex flex-col border-b select-none">
        <div className="flex items-center px-2 pt-2 gap-1 border-b bg-muted/10">
           <div className="h-8 w-16 bg-background border-t border-x rounded-t-sm flex items-center justify-center relative -bottom-[1px]">
             <Skeleton className="h-3 w-8" />
           </div>
           <div className="h-8 w-16 flex items-center justify-center opacity-50">
             <Skeleton className="h-3 w-8" />
           </div>
        </div>
        <div className="h-12 flex items-center px-4 gap-4 bg-muted/5">
           <div className="flex gap-2">
             <Skeleton className="h-8 w-8 rounded-sm" />
             <Skeleton className="h-8 w-8 rounded-sm" />
           </div>
           <div className="w-[1px] h-6 bg-border" />
           <div className="flex gap-2">
             <Skeleton className="h-8 w-24 rounded-sm" />
             <Skeleton className="h-8 w-10 rounded-sm" />
           </div>
           <div className="w-[1px] h-6 bg-border" />
           <div className="flex gap-2">
             <Skeleton className="h-8 w-8 rounded-sm" />
             <Skeleton className="h-8 w-8 rounded-sm" />
             <Skeleton className="h-8 w-8 rounded-sm" />
           </div>
        </div>
        <div className="h-9 flex items-center px-3 gap-3 border-t bg-background">
           <Skeleton className="h-6 w-10 rounded-sm shrink-0" />
           <div className="w-[1px] h-5 bg-border" />
           <Skeleton className="h-5 w-5 rounded-sm shrink-0" />
           <Skeleton className="h-6 w-full rounded-sm" />
        </div>
      </div>
      <div className="flex-1 relative overflow-hidden flex flex-col">
        <div className="flex border-b bg-muted/10">
          <div className="w-10 border-r flex-none bg-muted/20" />
          {['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'].map(col => (
            <div key={col} className="w-24 flex-none border-r py-1.5 flex items-center justify-center">
              <span className="text-[10px] font-semibold text-muted-foreground">{col}</span>
            </div>
          ))}
          <div className="flex-1 bg-muted/10" />
        </div>
        <div className="flex-1 overflow-hidden relative">
           <div className="absolute inset-0 overflow-hidden">
             {[...Array(50)].map((_, i) => (
               <div key={i} className="flex h-[28px] border-b">
                 <div className="w-10 flex-none border-r bg-muted/10 flex items-center justify-center">
                   <span className="text-[10px] text-muted-foreground">{i + 1}</span>
                 </div>
                 {[...Array(11)].map((_, j) => (
                   <div key={j} className="w-24 flex-none border-r relative group">
                      {Math.random() > 0.9 && i < 10 && (
                        <div className="absolute inset-1 rounded-sm bg-muted/20 animate-pulse" />
                      )}
                   </div>
                 ))}
                 <div className="flex-1" />
               </div>
             ))}
           </div>
        </div>
      </div>
      <div className="h-9 border-t flex items-center px-2 gap-2 bg-muted/5 z-10">
         <div className="flex gap-2 px-2">
             <Skeleton className="h-4 w-4" />
             <Skeleton className="h-4 w-4" />
         </div>
         <div className="px-4 py-1.5 bg-background border rounded-t-md border-b-0 shadow-sm flex items-center gap-2">
             <Skeleton className="h-3 w-16" />
         </div>
         <div className="px-3">
             <Skeleton className="h-3 w-16 opacity-50" />
         </div>
         <Skeleton className="h-3 w-4 ml-auto mr-2" />
      </div>
    </div>
  );
}
