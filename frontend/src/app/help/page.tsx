'use client';

import * as React from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { 
  Coins, 
  MessageCircle,
} from 'lucide-react';
import Link from 'next/link';

export default function HelpCenterPage() {
  return (
    <div className="max-w-4xl mx-auto py-8 px-4 sm:px-6 lg:px-8">
      <div className="mb-8">
        <h1 className="text-4xl font-bold mb-2">Help Center</h1>
        <p className="text-lg text-muted-foreground">
        </p>
      </div>

      <div className="space-y-8">
        <section>
          <h2 className="text-2xl font-semibold mb-4">Billing & Usage</h2>
          <p className="mb-6">
            Understand how credits work and manage your subscription.
          </p>

          <Link href="/help/credits-explained">
            <Card className="hover:bg-muted/50 transition-colors cursor-pointer">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-primary/10">
                    <Coins className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <CardTitle>What are Credits?</CardTitle>
                    <CardDescription>
                      Learn about credit types, how they're consumed, and pricing
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
            </Card>
          </Link>
        </section>
      </div>
    </div>
  );
}
