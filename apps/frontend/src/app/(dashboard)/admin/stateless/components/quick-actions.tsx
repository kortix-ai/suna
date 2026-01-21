"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  RefreshCw,
  Play,
  Trash2,
  RotateCcw,
  Loader2,
  AlertTriangle,
} from "lucide-react";

interface QuickAction {
  id: string;
  name: string;
  description: string;
  icon: React.ReactNode;
  dangerous?: boolean;
  confirmMessage?: string;
  requiresInput?: {
    label: string;
    placeholder: string;
    type?: string;
  };
}

interface QuickActionsProps {
  onSweep: () => void;
  onFlush: () => void;
  onPurgeDLQ: (hours?: number) => void;
  onResetBreakers: () => void;
  isSweeping: boolean;
  isFlushing: boolean;
  isPurging: boolean;
  isResetting: boolean;
}

const actions: QuickAction[] = [
  {
    id: "sweep",
    name: "Sweep",
    description: "Scan for stuck or orphaned runs and attempt recovery",
    icon: <RefreshCw className="w-4 h-4" />,
  },
  {
    id: "flush",
    name: "Flush",
    description: "Force flush all pending writes from WAL to database",
    icon: <Play className="w-4 h-4" />,
  },
  {
    id: "purge",
    name: "Purge DLQ",
    description: "Remove old entries from the dead letter queue",
    icon: <Trash2 className="w-4 h-4" />,
    dangerous: true,
    confirmMessage: "This will permanently delete DLQ entries. This action cannot be undone.",
    requiresInput: {
      label: "Delete entries older than (hours)",
      placeholder: "24",
      type: "number",
    },
  },
  {
    id: "reset",
    name: "Reset Breakers",
    description: "Reset all circuit breakers to closed state",
    icon: <RotateCcw className="w-4 h-4" />,
    confirmMessage: "This will reset all circuit breakers, potentially allowing failed operations to retry.",
  },
];

export function QuickActions({
  onSweep,
  onFlush,
  onPurgeDLQ,
  onResetBreakers,
  isSweeping,
  isFlushing,
  isPurging,
  isResetting,
}: QuickActionsProps) {
  const [confirmAction, setConfirmAction] = useState<QuickAction | null>(null);
  const [inputValue, setInputValue] = useState("");

  const isLoading = (id: string) => {
    switch (id) {
      case "sweep": return isSweeping;
      case "flush": return isFlushing;
      case "purge": return isPurging;
      case "reset": return isResetting;
      default: return false;
    }
  };

  const handleAction = (action: QuickAction) => {
    if (action.confirmMessage || action.requiresInput) {
      setConfirmAction(action);
      setInputValue(action.requiresInput?.placeholder || "");
    } else {
      executeAction(action.id);
    }
  };

  const executeAction = (id: string, value?: string) => {
    switch (id) {
      case "sweep":
        onSweep();
        break;
      case "flush":
        onFlush();
        break;
      case "purge":
        onPurgeDLQ(value ? parseInt(value) : undefined);
        break;
      case "reset":
        onResetBreakers();
        break;
    }
    setConfirmAction(null);
    setInputValue("");
  };

  const isAnyLoading = isSweeping || isFlushing || isPurging || isResetting;

  return (
    <>
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground mr-1">Actions:</span>
        {actions.map((action) => {
          const loading = isLoading(action.id);
          return (
            <TooltipProvider key={action.id}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={action.dangerous ? "outline" : "outline"}
                    size="sm"
                    onClick={() => handleAction(action)}
                    disabled={isAnyLoading}
                    className={cn(
                      "gap-1.5",
                      action.dangerous && "text-destructive hover:text-destructive"
                    )}
                  >
                    {loading ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      action.icon
                    )}
                    {action.name}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="text-xs max-w-[200px]">{action.description}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          );
        })}
      </div>

      {/* Confirmation Dialog */}
      <Dialog open={!!confirmAction} onOpenChange={() => setConfirmAction(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {confirmAction?.dangerous && (
                <AlertTriangle className="w-5 h-5 text-destructive" />
              )}
              {confirmAction?.name}
            </DialogTitle>
            <DialogDescription>
              {confirmAction?.confirmMessage || confirmAction?.description}
            </DialogDescription>
          </DialogHeader>

          {confirmAction?.requiresInput && (
            <div className="grid gap-2 py-2">
              <Label htmlFor="action-input">{confirmAction.requiresInput.label}</Label>
              <Input
                id="action-input"
                type={confirmAction.requiresInput.type || "text"}
                placeholder={confirmAction.requiresInput.placeholder}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
              />
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="ghost" onClick={() => setConfirmAction(null)}>
              Cancel
            </Button>
            <Button
              variant={confirmAction?.dangerous ? "destructive" : "default"}
              onClick={() => executeAction(confirmAction!.id, inputValue)}
              disabled={isLoading(confirmAction?.id || "")}
            >
              {isLoading(confirmAction?.id || "") && (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              )}
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
