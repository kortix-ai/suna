import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

interface ToolsLoaderProps {
  toolCount?: number;
}

export const ToolsLoader: React.FC<ToolsLoaderProps> = ({ 
  toolCount = 6 
}) => {
  return (
    <div className="flex-1 overflow-y-auto space-y-3">
        {Array.from({ length: toolCount }).map((_, index) => (
            <Card key={index} className="animate-pulse">
            <CardContent>
                <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                    <Skeleton className="h-4 w-32" />
                    </div>
                </div>
                <Skeleton className="h-6 w-11 rounded-full" />
                </div>
            </CardContent>
            </Card>
        ))}
    </div>
  );
}; 