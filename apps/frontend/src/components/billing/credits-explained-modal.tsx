'use client';

import { Zap, Clock, Sparkles, Info, RotateCcw, Infinity, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Card,
  CardContent,
} from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';

interface CreditsExplainedModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreditsExplainedModal({ open, onOpenChange }: CreditsExplainedModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-2xl font-medium">What are Credits?</DialogTitle>
        </DialogHeader>
        
        <div className="space-y-8 py-4">
          {/* Introduction */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold">Understanding Credits</h2>
            </div>
            <p className="text-muted-foreground leading-relaxed">
              Credits are the universal currency that powers everything you do on Kortix. 
              They're consumed when your AI agents work on tasks, and the cost varies based 
              on the complexity and resources required.
            </p>
          </div>

          {/* How Credits Work */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Zap className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold">How Credits Work</h2>
            </div>
            
            <p className="text-muted-foreground leading-relaxed">
              Credits are consumed based on the resources your AI agents use during task execution:
            </p>

            <Card>
              <CardContent className="pt-5">
                <ul className="space-y-2.5 text-sm text-muted-foreground">
                  <li className="flex items-start gap-3">
                    <div className="w-1.5 h-1.5 rounded-full bg-primary mt-1.5 flex-shrink-0" />
                    <div>
                      <span className="font-medium text-foreground">AI activity:</span> Processing requests, generating responses, and running AI models.
                    </div>
                  </li>
                  <li className="flex items-start gap-3">
                    <div className="w-1.5 h-1.5 rounded-full bg-primary mt-1.5 flex-shrink-0" />
                    <div>
                      <span className="font-medium text-foreground">Kortix computer:</span> Code execution, browser automation, and interactive task processing.
                    </div>
                  </li>
                  <li className="flex items-start gap-3">
                    <div className="w-1.5 h-1.5 rounded-full bg-primary mt-1.5 flex-shrink-0" />
                    <div>
                      <span className="font-medium text-foreground">Web & people search:</span> Finding information, data, and resources online.
                    </div>
                  </li>
                  <li className="flex items-start gap-3">
                    <div className="w-1.5 h-1.5 rounded-full bg-primary mt-1.5 flex-shrink-0" />
                    <div>
                      <span className="font-medium text-foreground">Third-party services:</span> External APIs and integrated services.
                    </div>
                  </li>
                </ul>
              </CardContent>
            </Card>
          </div>

          {/* Types of Credits */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Clock className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold">Types of Credits</h2>
            </div>

            <p className="text-muted-foreground leading-relaxed text-sm">
              Credits are deducted in priority order: daily credits first, then monthly, then extra credits.
            </p>

            {/* Credit Types Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {/* Daily Credits */}
              <Card className="border-blue-500/20 bg-gradient-to-br from-blue-500/5 to-transparent">
                <CardContent className="pt-4 pb-4">
                  <div className="flex items-center gap-2 mb-2">
                    <RotateCcw className="h-4 w-4 text-blue-500" />
                    <h3 className="font-semibold text-sm">Daily</h3>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Refresh every 24 hours. Use it or lose it.
                  </p>
                </CardContent>
              </Card>

              {/* Monthly Credits */}
              <Card className="border-orange-500/20 bg-gradient-to-br from-orange-500/5 to-transparent">
                <CardContent className="pt-4 pb-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Clock className="h-4 w-4 text-orange-500" />
                    <h3 className="font-semibold text-sm">Monthly</h3>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Included with your plan. Refresh each billing cycle.
                  </p>
                </CardContent>
              </Card>

              {/* Extra Credits */}
              <Card className="border-border">
                <CardContent className="pt-4 pb-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Infinity className="h-4 w-4 text-muted-foreground" />
                    <h3 className="font-semibold text-sm">Extra</h3>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Purchased or promo credits that never expire.
                  </p>
                </CardContent>
              </Card>
            </div>
          </div>

          {/* Priority Order Info */}
          <Alert className="border-blue-500/20 bg-blue-500/5">
            <Info className="h-4 w-4" />
            <AlertDescription className="text-sm">
              <strong>Credit priority:</strong> We use expiring credits first (daily → monthly) before extra credits, 
              so you get the most value from all your credits.
            </AlertDescription>
          </Alert>

          {/* Refund Policy */}
          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription className="text-sm">
              If a task fails due to a system error, we automatically refund all credits used for that task.
            </AlertDescription>
          </Alert>
        </div>
      </DialogContent>
    </Dialog>
  );
}
