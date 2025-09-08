'use client';

import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { 
  ShoppingCart, 
  Clock, 
  Infinity,
  Coins,
  AlertCircle
} from 'lucide-react';
import { useCreditBalance, usePurchaseCredits } from '@/hooks/react-query/use-billing-v2';
import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { toast } from 'sonner';

interface CreditBalanceCardProps {
  showPurchaseButton?: boolean;
  compact?: boolean;
  tierCredits?: number;
}

export function CreditBalanceCard({ 
  showPurchaseButton = true, 
  compact = false,
  tierCredits 
}: CreditBalanceCardProps) {
  const { data: balance, isLoading, error } = useCreditBalance();
  const [showPurchaseModal, setShowPurchaseModal] = useState(false);
  const [purchaseAmount, setPurchaseAmount] = useState('10');
  
  const purchaseMutation = usePurchaseCredits();

  if (error) {
    return (
      <Card className="border-destructive">
        <CardContent className="pt-6">
          <div className="flex items-center gap-2 text-destructive">
            <AlertCircle className="h-4 w-4" />
            <span className="text-sm">Failed to load balance</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-4 w-24" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-8 w-32 mb-2" />
          <Skeleton className="h-2 w-full mb-2" />
          <Skeleton className="h-4 w-48" />
        </CardContent>
      </Card>
    );
  }

  if (!balance) return null;

  // Ensure we have the credit breakdown values (backwards compatibility)
  const expiringCredits = balance.expiring_credits ?? balance.balance;
  const nonExpiringCredits = balance.non_expiring_credits ?? 0;
  const hasBreakdown = balance.expiring_credits !== undefined && balance.non_expiring_credits !== undefined;

  // Calculate availability percentage based on tier limit
  // For monthly reset: available percentage = (balance / tier_limit) * 100
  // Use tierCredits if provided, otherwise assume balance is full (100%)
  const maxCredits = tierCredits || balance.balance;
  const availablePercentage = maxCredits > 0 
    ? (balance.balance / maxCredits) * 100 
    : 100; // If no max, show as full

  const handlePurchase = async () => {
    const amount = parseFloat(purchaseAmount);
    if (isNaN(amount) || amount <= 0) {
      toast.error('Please enter a valid amount');
      return;
    }

    const returnUrl = typeof window !== 'undefined' ? window.location.href : '/';

    purchaseMutation.mutate({
      amount,
      success_url: `${returnUrl}?purchase=success`,
      cancel_url: `${returnUrl}?purchase=cancelled`,
    }, {
      onSuccess: () => {
        setShowPurchaseModal(false);
        toast.success('Redirecting to checkout...');
      },
      onError: (error) => {
        toast.error(`Failed to create checkout: ${error.message}`);
      },
    });
  };

  // Format date for next credit grant
  const formatNextGrant = (dateString?: string) => {
    if (!dateString) return null;
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { 
      month: 'short', 
      day: 'numeric', 
      year: 'numeric' 
    });
  };

  if (compact) {
    return (
      <div className="flex items-center gap-4 p-4 rounded-lg border bg-card">
        <div className="flex items-center gap-2">
          <Coins className="h-5 w-5 text-primary" />
          <div>
            <p className="text-sm text-muted-foreground">Credit Balance</p>
            <p className="text-2xl font-bold">${balance.balance.toFixed(2)}</p>
            {hasBreakdown && showPurchaseButton && balance.can_purchase_credits && (expiringCredits > 0 || nonExpiringCredits > 0) && (
              <div className="flex gap-3 mt-1">
                <span className="text-xs text-muted-foreground">
                  <Clock className="h-3 w-3 inline mr-1 text-orange-500" />
                  ${expiringCredits.toFixed(2)}
                </span>
                <span className="text-xs text-muted-foreground">
                  <Infinity className="h-3 w-3 inline mr-1 text-green-500" />
                  ${nonExpiringCredits.toFixed(2)}
                </span>
              </div>
            )}
          </div>
        </div>
        {showPurchaseButton && balance.can_purchase_credits && (
          <Button
            onClick={() => setShowPurchaseModal(true)}
            size="sm"
            variant="outline"
          >
            <ShoppingCart className="h-4 w-4 mr-1" />
            Buy Credits
          </Button>
        )}
      </div>
    );
  }

  return (
    <>
      <Card className='border-0 shadow-none bg-transparent p-0 mt-2'>
        <CardContent className="space-y-4 p-0">
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-bold">${balance.balance.toFixed(2)}</span>
                <span className="text-sm text-muted-foreground">total available</span>
              </div>
            </div>
          </div>
          {showPurchaseButton && balance.can_purchase_credits && (
            <div className="pt-2">
              <Button 
                onClick={() => setShowPurchaseModal(true)} 
                className="w-full"
                variant="outline"
              >
                <ShoppingCart className="h-4 w-4" />
                Purchase Additional Credits
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
      <Dialog open={showPurchaseModal} onOpenChange={setShowPurchaseModal}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Purchase Credits</DialogTitle>
            <DialogDescription>
              <Alert className='mt-2 border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-900/20'>
                <Infinity className="h-4 w-4 text-green-600" />
                <AlertDescription>
                  <span className="text-green-700 dark:text-green-300">
                    Purchased credits never expire and are used only after your plan credits are exhausted.
                  </span>
                </AlertDescription>
              </Alert>
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="amount">Credit Amount (USD)</Label>
              <Input
                id="amount"
                type="number"
                min="1"
                step="1"
                value={purchaseAmount}
                onChange={(e) => setPurchaseAmount(e.target.value)}
                placeholder="Enter amount"
              />
              <p className="text-sm text-muted-foreground">
                $1 = 1 credit. Minimum purchase: $1
              </p>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <Button
                variant="outline"
                className="flex-1 h-24 text-2xl font-bold"
                onClick={() => setPurchaseAmount('10')}
              >
                $10
              </Button>
              <Button
                variant="outline"
                className="flex-1 h-24 text-2xl font-bold"
                onClick={() => setPurchaseAmount('25')}
              >
                $25
              </Button>
              <Button
                variant="outline"
                className="flex-1 h-24 text-2xl font-bold"
                onClick={() => setPurchaseAmount('50')}
              >
                $50
              </Button>
              <Button
                variant="outline"
                className="flex-1 h-24 text-2xl font-bold"
                onClick={() => setPurchaseAmount('100')}
              >
                $100
              </Button>
              <Button
                variant="outline"
                className="flex-1 h-24 text-2xl font-bold"
                onClick={() => setPurchaseAmount('200')}
              >
                $200
              </Button>
              <Button
                variant="outline"
                className="flex-1 h-24 text-2xl font-bold"
                onClick={() => setPurchaseAmount('500')}
              >
                $500
              </Button>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="outline"
                onClick={() => setShowPurchaseModal(false)}
              >
                Cancel
              </Button>
              <Button
                onClick={handlePurchase}
                disabled={purchaseMutation.isPending}
              >
                {purchaseMutation.isPending ? 'Processing...' : `Purchase $${purchaseAmount}`}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
} 