"use client";

import { cn } from '@/lib/utils';
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MAINTENANCE_LEVELS } from "./constants";
import type { MaintenanceLevel } from "@/lib/maintenance-store";

interface MaintenanceLevelCardProps {
  level: MaintenanceLevel;
  isSelected: boolean;
  onClick: () => void;
}

export function MaintenanceLevelCard({ level, isSelected, onClick }: MaintenanceLevelCardProps) {
  const config = MAINTENANCE_LEVELS.find((l) => l.value === level)!;
  const Icon = config.icon;

  return (
    <Card
      className={cn(
        'cursor-pointer transition-all p-4',
        isSelected
          ? `border-2 ${config.borderColor} ${config.bgColor}`
          : 'border hover:border-primary/50',
      )}
      onClick={onClick}
    >
      <CardContent className="p-0">
        <div className="flex items-center gap-3">
          <div
            className={cn(
              'flex items-center justify-center w-10 h-10 rounded-xl border',
              isSelected ? `${config.bgColor} ${config.borderColor}` : 'bg-muted border-border',
            )}
          >
            <Icon className={cn('w-5 h-5', isSelected ? config.color : 'text-muted-foreground')} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{config.label}</span>
              {isSelected && (
                <Badge className={cn('text-[10px] px-1.5 py-0', config.bgColor, config.color, config.borderColor)}>
                  Active
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">{config.description}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
