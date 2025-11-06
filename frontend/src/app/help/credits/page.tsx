'use client';

import * as React from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { 
  Coins, 
  Clock, 
  Infinity, 
  Zap, 
  Gift, 
  RefreshCw, 
  DollarSign,
  Mail,
  MessageCircle,
  Info,
  ArrowLeft
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import Link from 'next/link';

export default function CreditsPage() {
  return (
    <div className="max-w-4xl mx-auto py-8 px-4 sm:px-6 lg:px-8">
      <div className="mb-8">
        <Link href="/help">
          <Button variant="ghost" className="mb-4">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Help Center
          </Button>
        </Link>
        <h1 className="text-4xl font-bold mb-2">What are Credits?</h1>
        <p className="text-lg text-muted-foreground">
          Learn how credits work and how they're consumed
        </p>
      </div>

      <div className="space-y-8">
        <section>
          <h2 className="text-2xl font-semibold mb-4">What are credits?</h2>
          <p className="text-lg mb-8">
            Credits are Kortix's standard unit of measurement for platform usage. Think of them as tokens that power your AI agents - the more complex or lengthy the task, the more credits it requires.
          </p>
        </section>

        <section>
          <h2 className="text-2xl font-semibold mb-4">Types of Credits</h2>
          <p className="mb-6">
            Kortix uses two types of credits to give you flexibility in how you manage your usage:
          </p>

          <div className="grid gap-4 md:grid-cols-2 mb-8">
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
                  These credits are included with your paid subscription and are renewed automatically each month 
                  on your subscription date. They expire at the end of each billing cycle and are always consumed 
                  first before any non-expiring credits.
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
                  These credits never expire and carry over month to month. They include top-up purchases, 
                  refunds, and promotional grants. Non-expiring credits are only used after your expiring 
                  credits have been depleted.
                </p>
              </CardContent>
            </Card>
          </div>

          <Alert className="mb-8">
            <Info className="h-4 w-4" />
            <AlertDescription>
              <strong>Credit Priority:</strong> When you use Kortix, expiring credits are consumed first. 
              Only after your expiring credits run out will non-expiring credits be used.
            </AlertDescription>
          </Alert>
        </section>

        <section>
          <h2 className="text-2xl font-semibold mb-4">How Credits Work</h2>
          <p className="mb-6">
            Credits are consumed based on the resources your AI agents use:
          </p>

          <div className="space-y-4 mb-8">
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
                  Different AI models have different costs based on their capabilities and token usage. 
                  Credits are consumed for input tokens (your prompts and context), output tokens (agent responses), 
                  and vary by model tier (GPT-4, Claude, etc.).
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-primary/10">
                    <DollarSign className="h-5 w-5 text-primary" />
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
                  We apply a 20% markup on all API and model costs to cover platform infrastructure, 
                  security, and ongoing development. This transparent pricing ensures you know exactly 
                  what you're paying for.
                </p>
              </CardContent>
            </Card>
          </div>
        </section>

        <section>
          <h2 className="text-2xl font-semibold mb-4">Getting More Credits</h2>
          <p className="mb-6">
            There are several ways to obtain credits in Kortix:
          </p>

          <div className="space-y-4 mb-8">
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
        </section>

        <section>
          <h2 className="text-2xl font-semibold mb-4">Tracking Your Usage</h2>
          <p className="mb-6">
            Monitor your credit consumption through the Settings panel:
          </p>

          <div className="space-y-3 mb-8">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Settings → Billing</CardTitle>
                <CardDescription>
                  View your current credit balance and breakdown between expiring and non-expiring credits
                </CardDescription>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Settings → Usage</CardTitle>
                <CardDescription>
                  Track credit consumption by thread and conversation to identify your most resource-intensive chats
                </CardDescription>
              </CardHeader>
            </Card>
          </div>
        </section>

        <section>
          <h2 className="text-2xl font-semibold mb-4">Optimizing Credit Usage</h2>
          <p className="mb-6">
            Make your credits go further with these optimization strategies:
          </p>

          <div className="space-y-3 mb-8">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Choose Appropriate Models</CardTitle>
                <CardDescription>
                  Use smaller, more efficient models for simpler tasks. Save advanced models like GPT-4 for complex reasoning.
                </CardDescription>
              </CardHeader>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Provide Clear Instructions</CardTitle>
                <CardDescription>
                  Well-defined tasks reduce back-and-forth with the agent, saving tokens and credits.
                </CardDescription>
              </CardHeader>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Monitor Your Usage</CardTitle>
                <CardDescription>
                  Regularly check the Usage tab to identify which conversations consume the most credits and adjust accordingly.
                </CardDescription>
              </CardHeader>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Leverage Prompt Caching</CardTitle>
                <CardDescription>
                  Repeated conversations in the same thread benefit from prompt caching, reducing token costs significantly.
                </CardDescription>
              </CardHeader>
            </Card>
          </div>
        </section>

        <section>
          <h2 className="text-2xl font-semibold mb-4">Need Help?</h2>
          <p className="mb-6">
            If you notice any discrepancies in your credit usage or have questions about billing:
          </p>

          <div className="flex flex-col sm:flex-row gap-3 mb-8">
            <Button
              variant="outline"
              className="gap-2"
              onClick={() => window.location.href = 'mailto:support@kortix.ai'}
            >
              <Mail className="h-4 w-4" />
              Email Support
            </Button>
            <Button
              variant="outline"
              className="gap-2"
              onClick={() => window.open('https://discord.gg/kortix', '_blank')}
            >
              <MessageCircle className="h-4 w-4" />
              Join Discord
            </Button>
          </div>

          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription>
              We're committed to fair and transparent billing. If you believe there's an error in your 
              credit usage, please contact our support team and we'll investigate promptly.
            </AlertDescription>
          </Alert>
        </section>
      </div>
    </div>
  );
}
