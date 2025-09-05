'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import {
  Coins,
  TrendingUp,
  TrendingDown,
  ShoppingCart,
  CreditCard,
  AlertCircle,
} from 'lucide-react';
import { useCreditBalance, usePurchaseCredits } from '@/hooks/react-query/use-billing-v2';
import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';

interface CreditBalanceCardProps {
  showPurchaseButton?: boolean;
  compact?: boolean;
}

export function CreditBalanceCard({ 
  showPurchaseButton = true, 
  compact = false 
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

  const usagePercentage = balance.lifetime_used > 0 
    ? (balance.balance / (balance.balance + balance.lifetime_used)) * 100 
    : 100;

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

  if (compact) {
    return (
      <div className="flex items-center gap-4 p-4 rounded-lg border bg-card">
        <div className="flex items-center gap-2">
          <Coins className="h-5 w-5 text-primary" />
          <div>
            <p className="text-sm text-muted-foreground">Credit Balance</p>
            <p className="text-2xl font-bold">${balance.balance.toFixed(2)}</p>
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
            <div className="flex items-baseline gap-2 mb-2">
              <span className="text-3xl font-bold">${balance.balance.toFixed(2)}</span>
              <span className="text-sm text-muted-foreground">available</span>
            </div>
            <Progress value={usagePercentage} className="h-2" />
          </div>
          {showPurchaseButton && balance.can_purchase_credits && (
            <div className="pt-2 border-t">
              <Button 
                onClick={() => setShowPurchaseModal(true)} 
                className="w-full"
                variant="outline"
              >
                <ShoppingCart className="h-4 w-4 mr-2" />
                Purchase Additional Credits
              </Button>
              <p className="text-xs text-muted-foreground text-center mt-2">
                Available for highest tier subscribers
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={showPurchaseModal} onOpenChange={setShowPurchaseModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Purchase Credits</DialogTitle>
            <DialogDescription>
              Add more credits to your account. Credits never expire.
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

            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => setPurchaseAmount('10')}
              >
                $10
              </Button>
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => setPurchaseAmount('25')}
              >
                $25
              </Button>
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => setPurchaseAmount('50')}
              >
                $50
              </Button>
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => setPurchaseAmount('100')}
              >
                $100
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