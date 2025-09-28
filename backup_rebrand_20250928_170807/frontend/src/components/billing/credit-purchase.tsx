'use client';

import { useState } from 'react';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Loader2, CreditCard, AlertCircle, Zap, AlertCircleIcon } from 'lucide-react';
import { apiClient, backendApi } from '@/lib/api-client';
import { toast } from 'sonner';

interface CreditPurchaseProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    currentBalance?: number;
    canPurchase: boolean;
    onPurchaseComplete?: () => void;
}

interface CreditPackage {
    amount: number;
    price: number;
    popular?: boolean;
}

const CREDIT_PACKAGES: CreditPackage[] = [
    { amount: 10, price: 10 },
    { amount: 25, price: 25 },
    { amount: 50, price: 50 },
    { amount: 100, price: 100, popular: true },
    { amount: 250, price: 250 },
    { amount: 500, price: 500 },
];

export function CreditPurchaseModal({ 
    open, 
    onOpenChange, 
    currentBalance = 0,
    canPurchase,
    onPurchaseComplete 
}: CreditPurchaseProps) {
    const [selectedPackage, setSelectedPackage] = useState<CreditPackage | null>(null);
    const [customAmount, setCustomAmount] = useState<string>('');
    const [isProcessing, setIsProcessing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handlePurchase = async (amount: number) => {
        if (amount < 10) {
            setError('Minimum purchase amount is $10');
            return;
        }
        if (amount > 5000) {
            setError('Maximum purchase amount is $5000');
            return;
        }
        setIsProcessing(true);
        setError(null);
        try {
            const response = await backendApi.post('/billing/purchase-credits', {
                amount_dollars: amount,
                success_url: `${window.location.origin}/dashboard?credit_purchase=success`,
                cancel_url: `${window.location.origin}/dashboard?credit_purchase=cancelled`
            });
            if (response.data.url) {
                window.location.href = response.data.url;
            } else {
                throw new Error('No checkout URL received');
            }
        } catch (err: any) {
            console.error('Credit purchase error:', err);
            const errorMessage = err.response?.data?.detail || err.message || 'Failed to create checkout session';
            setError(errorMessage);
            toast.error(errorMessage);
        } finally {
            setIsProcessing(false);
        }
    };

    const handlePackageSelect = (pkg: CreditPackage) => {
        setSelectedPackage(pkg);
        setCustomAmount('');
        setError(null);
    };

    const handleCustomAmountChange = (value: string) => {
        setCustomAmount(value);
        setSelectedPackage(null);
        setError(null);
    };

    const handleConfirmPurchase = () => {
        const amount = selectedPackage ? selectedPackage.amount : parseFloat(customAmount);
        if (!isNaN(amount)) {
            handlePurchase(amount);
        } else {
            setError('Please select a package or enter a valid amount');
        }
    };

    if (!canPurchase) {
        return (
            <Dialog open={open} onOpenChange={onOpenChange}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Credits Not Available</DialogTitle>
                        <DialogDescription>
                            Credit purchases are only available for users on the highest subscription tier ($1000/month).
                        </DialogDescription>
                    </DialogHeader>
                    <Alert>
                        <AlertCircle className="h-4 w-4" />
                        <AlertDescription>
                            Please upgrade your subscription to the highest tier to unlock credit purchases for unlimited usage.
                        </AlertDescription>
                    </Alert>
                    <div className="flex justify-end">
                        <Button variant="outline" onClick={() => onOpenChange(false)}>
                            Close
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        );
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Zap className="h-5 w-5 text-amber-500 dark:text-amber-400" />
                        Purchase Credits
                    </DialogTitle>
                    <DialogDescription>
                        Add credits to your account for usage beyond your subscription limit.
                    </DialogDescription>
                </DialogHeader>

                {currentBalance > 0 && (
                    <Alert className="text-purple-600 dark:text-purple-400 bg-purple-50 border-purple-200 dark:bg-purple-950 dark:border-purple-800">
                        <AlertCircleIcon className="h-4 w-4" />
                        <AlertDescription className="text-purple-600 dark:text-purple-400">
                            Current balance: <strong>${currentBalance.toFixed(2)}</strong>
                        </AlertDescription>
                    </Alert>
                )}

                <div className="space-y-4">
                    <div>
                        <Label className="text-base font-semibold mb-3 block">Select a Package</Label>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                            {CREDIT_PACKAGES.map((pkg) => (
                                <Card
                                    key={pkg.amount}
                                    className={`cursor-pointer transition-all ${
                                        selectedPackage?.amount === pkg.amount
                                            ? 'ring-2 ring-primary'
                                            : 'hover:shadow-md'
                                    }`}
                                    onClick={() => handlePackageSelect(pkg)}
                                >
                                    <CardContent className="p-4 text-center relative">
                                        {pkg.popular && (
                                            <Badge className="absolute -top-2 -right-2" variant="default">
                                                Popular
                                            </Badge>
                                        )}
                                        <div className="text-2xl font-bold">${pkg.amount}</div>
                                        <div className="text-sm text-muted-foreground">credits</div>
                                    </CardContent>
                                </Card>
                            ))}
                        </div>
                    </div>
                    {error && (
                        <Alert variant="destructive">
                            <AlertCircle className="h-4 w-4" />
                            <AlertDescription>{error}</AlertDescription>
                        </Alert>
                    )}
                </div>
                <div className="flex justify-end gap-3 mt-6">
                    <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                        disabled={isProcessing}
                    >
                        Cancel
                    </Button>
                    <Button
                        onClick={handleConfirmPurchase}
                        disabled={isProcessing || (!selectedPackage && !customAmount)}
                    >
                        {isProcessing ? (
                            <>
                                <Loader2 className="h-4 w-4 animate-spin" />
                                Processing...
                            </>
                        ) : (
                            <>
                                <CreditCard className="h-4 w-4" />
                                Purchase Credits
                            </>
                        )}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}

export function CreditBalanceDisplay({ balance, canPurchase, onPurchaseClick }: {
    balance: number;
    canPurchase: boolean;
    onPurchaseClick?: () => void;
}) {
    return (
        <Card>
            <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium flex items-center justify-between">
                    <span className="flex items-center gap-2">
                        <Zap className="h-4 w-4 text-yellow-500" />
                        Credit Balance
                    </span>
                    {canPurchase && onPurchaseClick && (
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={onPurchaseClick}
                        >
                            Add Credits
                        </Button>
                    )}
                </CardTitle>
            </CardHeader>
            <CardContent>
                <div className="text-2xl font-bold">
                    ${balance.toFixed(2)}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                    {canPurchase 
                        ? 'Available for usage beyond subscription limits'
                        : 'Upgrade to highest tier to purchase credits'
                    }
                </p>
            </CardContent>
        </Card>
    );
} 