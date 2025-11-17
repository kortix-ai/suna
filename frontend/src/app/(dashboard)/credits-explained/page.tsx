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

          <div className="space-y-4">
            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-primary/10">
                    <Zap className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <CardTitle>{t('howCreditsWork.aiModelUsage.title')}</CardTitle>
                    <CardDescription>
                      {t('howCreditsWork.aiModelUsage.description')}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  {t('howCreditsWork.aiModelUsage.content')}
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
                    <CardTitle>{t('howCreditsWork.pricingModel.title')}</CardTitle>
                    <CardDescription>
                      {t('howCreditsWork.pricingModel.description')}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  {t('howCreditsWork.pricingModel.content')}
                </p>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Getting More Credits */}
        <div className="space-y-6">
          <div className="flex items-center gap-2">
            <ShoppingCart className="h-5 w-5 text-primary" />
            <h2 className="text-xl font-semibold">{t('gettingMoreCredits.title')}</h2>
          </div>

          <p className="text-muted-foreground leading-relaxed">
            {t('gettingMoreCredits.description')}
          </p>

          <div className="space-y-4">
            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-primary/10">
                    <RefreshCw className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <CardTitle>{t('gettingMoreCredits.monthlySubscription.title')}</CardTitle>
                    <CardDescription>
                      {t('gettingMoreCredits.monthlySubscription.description')}
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
                    <CardTitle>{t('gettingMoreCredits.topUpCredits.title')}</CardTitle>
                    <CardDescription>
                      {t('gettingMoreCredits.topUpCredits.description')}
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
                    <CardTitle>{t('gettingMoreCredits.promotionalGrants.title')}</CardTitle>
                    <CardDescription>
                      {t('gettingMoreCredits.promotionalGrants.description')}
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
                    <CardTitle>{t('gettingMoreCredits.refunds.title')}</CardTitle>
                    <CardDescription>
                      {t('gettingMoreCredits.refunds.description')}
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
            <h2 className="text-xl font-semibold">{t('typesOfCredits.title')}</h2>
          </div>

          <p className="text-muted-foreground leading-relaxed">
            {t('typesOfCredits.description')}
          </p>

          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-primary/10">
                    <Clock className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <CardTitle>{t('typesOfCredits.expiringCredits.title')}</CardTitle>
                    <CardDescription>
                      {t('typesOfCredits.expiringCredits.description')}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  {t('typesOfCredits.expiringCredits.content')}
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
                    <CardTitle>{t('typesOfCredits.nonExpiringCredits.title')}</CardTitle>
                    <CardDescription>
                      {t('typesOfCredits.nonExpiringCredits.description')}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  {t('typesOfCredits.nonExpiringCredits.content')}
                </p>
              </CardContent>
            </Card>
          </div>

          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription>
              <strong>{t('typesOfCredits.creditPriority.title')}</strong> {t('typesOfCredits.creditPriority.description')}
            </AlertDescription>
          </Alert>
        </div>

      </div>
    </div>
  );
}
