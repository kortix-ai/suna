'use client';

import { Zap, Clock, Sparkles, ShoppingCart, Info, Coins, Infinity, RefreshCw, Gift } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';

export default function CreditsPage() {

  return (
    <div className="container mx-auto max-w-4xl px-4 py-8 md:py-12">
      {/* Header Section */}
      <div className="space-y-3 mb-10">
        <h1 className="text-3xl md:text-4xl font-medium tracking-tight text-foreground">
          Credits Explained
        </h1>
        <p className="text-lg text-muted-foreground">
          Everything you need to know about how credits work on Kortix
        </p>
      </div>

      <div className="space-y-10">
        {/* Introduction */}
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            <h2 className="text-xl font-semibold">Understanding Credits</h2>
          </div>
          <p className="text-muted-foreground leading-relaxed text-base">
            Credits serve as Kortix's universal currency for platform operations. Every action your AI agents perform—from analyzing data to generating code—consumes credits based on the task's complexity and the resources required.
          </p>
        </div>

        {/* How Credits Work */}
        <div className="space-y-6">
          <div className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-primary" />
            <h2 className="text-xl font-semibold">How Credits Work</h2>
          </div>
          
          <p className="text-muted-foreground leading-relaxed">
            Credits are consumed based on the resources your AI agents use:
          </p>

          <div className="space-y-4">
            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-primary/10">
                    <Zap className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <CardTitle>AI Model Usage</CardTitle>
                    <CardDescription>
                      The primary driver of credit consumption
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  Different AI models have different costs based on their capabilities and token usage. Credits are consumed for input tokens (your prompts and context), output tokens (agent responses), and vary by model tier (Claude, GPT, etc.).
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-primary/10">
                    <Coins className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <CardTitle>Pricing Model</CardTitle>
                    <CardDescription>
                      20% markup on AI model costs
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  We apply a 20% markup on all API and model costs to cover platform infrastructure, security, and ongoing development. This transparent pricing ensures you know exactly what you're paying for.
                </p>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Getting More Credits */}
        <div className="space-y-6">
          <div className="flex items-center gap-2">
            <ShoppingCart className="h-5 w-5 text-primary" />
            <h2 className="text-xl font-semibold">Getting More Credits</h2>
          </div>

          <p className="text-muted-foreground leading-relaxed">
            There are several ways to obtain credits in Kortix:
          </p>

          <div className="space-y-4">
            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-primary/10">
                    <RefreshCw className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <CardTitle>Monthly Subscription Credits</CardTitle>
                    <CardDescription>
                      Included with your paid plan and renewed automatically each month. These are expiring credits.
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-primary/10">
                    <Coins className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <CardTitle>Top-Up Credits</CardTitle>
                    <CardDescription>
                      Purchase additional credits when you need them. These are non-expiring and available to premium members.
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-primary/10">
                    <Gift className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <CardTitle>Promotional & Event Grants</CardTitle>
                    <CardDescription>
                      Bonus credits from special events, promotions, or referrals. These are non-expiring.
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-primary/10">
                    <RefreshCw className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <CardTitle>Refunds</CardTitle>
                    <CardDescription>
                      Credits returned due to technical issues or failed tasks. These are non-expiring.
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
            </Card>
          </div>
        </div>

        {/* Types of Credits */}
        <div className="space-y-6">
          <div className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-primary" />
            <h2 className="text-xl font-semibold">Types of Credits</h2>
          </div>

          <p className="text-muted-foreground leading-relaxed">
            Kortix uses two types of credits to give you flexibility in how you manage your usage:
          </p>

          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-primary/10">
                    <Clock className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <CardTitle>Expiring Credits</CardTitle>
                    <CardDescription>
                      Monthly subscription credits
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  These credits are included with your paid subscription and are renewed automatically each month on your subscription date. They expire at the end of each billing cycle and are always consumed first before any non-expiring credits.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-primary/10">
                    <Infinity className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <CardTitle>Non-Expiring Credits</CardTitle>
                    <CardDescription>
                      Permanent credits that never expire
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  These credits never expire and carry over month to month. They include top-up purchases, refunds, and promotional grants. Non-expiring credits are only used after your expiring credits have been depleted.
                </p>
              </CardContent>
            </Card>
          </div>

          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription>
              <strong>Credit Priority:</strong> When you use Kortix, expiring credits are consumed first. Only after your expiring credits run out will non-expiring credits be used.
            </AlertDescription>
          </Alert>
        </div>

      </div>
    </div>
  );
}
