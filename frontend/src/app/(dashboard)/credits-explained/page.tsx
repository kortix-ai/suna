'use client';

import { Zap, Clock, Sparkles, Info } from 'lucide-react';
import {
  Card,
  CardContent,
  CardHeader,
} from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useTranslations } from 'next-intl';

export default function CreditsPage() {
  const t = useTranslations('billing.creditsExplainedPage');

  return (
    <div className="container mx-auto max-w-4xl px-4 py-8 md:py-12">
      {/* Header Section */}
      <div className="space-y-3 mb-10">
        <h1 className="text-3xl md:text-4xl font-medium tracking-tight text-foreground">
          {t('title')}
        </h1>
        <p className="text-lg text-muted-foreground">
          {t('subtitle')}
        </p>
      </div>

      <div className="space-y-10">
        {/* Introduction */}
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            <h2 className="text-xl font-semibold">{t('understandingCredits.title')}</h2>
          </div>
          <p className="text-muted-foreground leading-relaxed text-base">
            {t('understandingCredits.description')}
          </p>
        </div>

        {/* How Credits Work */}
        <div className="space-y-6">
          <div className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-primary" />
            <h2 className="text-xl font-semibold">{t('howCreditsWork.title')}</h2>
          </div>
          
          <p className="text-muted-foreground leading-relaxed">
            {t('howCreditsWork.description')}
          </p>

          <Card>
            <CardContent className="pt-6">
              <ul className="space-y-3 text-muted-foreground">
                <li className="flex items-start gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                  <div>
                    <span className="font-medium text-foreground">AI activity:</span> Processing requests, generating responses, making decisions, and running AI models during task execution.
                  </div>
                </li>
                <li className="flex items-start gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                  <div>
                    <span className="font-medium text-foreground">Kortix computer:</span> The execution environment that powers code execution, browser automation, and interactive task processing.
                  </div>
                </li>
                <li className="flex items-start gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                  <div>
                    <span className="font-medium text-foreground">File storage and management:</span> Storing, organizing, and managing files created during your tasks.
                  </div>
                </li>
                <li className="flex items-start gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                  <div>
                    <span className="font-medium text-foreground">Web search:</span> Searching the internet for information, data, and resources needed to complete tasks.
                  </div>
                </li>
                <li className="flex items-start gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                  <div>
                    <span className="font-medium text-foreground">People search:</span> Finding and retrieving information about people, contacts, and professional data.
                  </div>
                </li>
                <li className="flex items-start gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                  <div>
                    <span className="font-medium text-foreground">Third-party services:</span> Accessing external APIs, databases, and integrated services that extend your agent's capabilities.
                  </div>
                </li>
              </ul>
              <div className="mt-6 pt-6 border-t border-border">
                <p className="text-muted-foreground leading-relaxed">
                  Once a task completes, no further credits are consumed. Your completed work, stored files, and deployed projects remain accessible without any ongoing credit costs.
                </p>
              </div>
              <Alert className="mt-4">
                <Info className="h-4 w-4" />
                <AlertDescription>
                  If a task fails due to a system error on our side, we'll automatically refund all credits used for that task. We're constantly improving our infrastructure to make credit usage more efficient.
                </AlertDescription>
              </Alert>
            </CardContent>
          </Card>
        </div>

        {/* Types of Credits */}
        <div className="space-y-6">
          <div className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-primary" />
            <h2 className="text-xl font-semibold">{t('typesOfCredits.title')}</h2>
          </div>

          <p className="text-muted-foreground leading-relaxed">
            Credits fall into two categories: expiring and non-expiring. When you run a task, credits are deducted in this priority order: expiring credits first (daily, then monthly), followed by non-expiring credits.
          </p>

          <div className="space-y-4">
            <div>
              <h3 className="font-semibold text-foreground mb-3">Expiring credits</h3>
              <div className="space-y-3 text-muted-foreground">
                <div className="flex items-start gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                  <div>
                    <span className="font-medium text-foreground">Daily credits:</span> These credits expire at the end of each day and must be used within 24 hours.
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                  <div>
                    <span className="font-medium text-foreground">Monthly credits:</span> These credits expire at the end of each billing cycle or month. They're typically tied to subscription plans and renew automatically each month.
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                  <div>
                    <span className="font-medium text-foreground">Promotional & event grants:</span> Bonus credits from special events, promotions, or referrals that have expiration dates. These expire when the event or promotion period ends.
                  </div>
                </div>
              </div>
            </div>

            <div className="pt-4 border-t border-border">
              <h3 className="font-semibold text-foreground mb-3">Non-expiring credits</h3>
              <div className="space-y-3 text-muted-foreground">
                <div className="flex items-start gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                  <div>
                    <span className="font-medium text-foreground">Top-up credits:</span> Additional credits you purchase when needed. These are non-expiring and available to ULTRA members.
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                  <div>
                    <span className="font-medium text-foreground">Promotional & event grants:</span> Bonus credits from special events, promotions, or referrals that don't have expiration dates. These remain in your account until used.
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                  <div>
                    <span className="font-medium text-foreground">Free credits:</span> Complimentary credits provided to your account have no expiration date and stay available indefinitely.
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
