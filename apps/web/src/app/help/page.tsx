'use client';

import { useTranslations } from 'next-intl';

import * as React from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { 
  Coins, 
  MessageCircle,
} from 'lucide-react';
import Link from 'next/link';

export default function HelpCenterPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="max-w-4xl mx-auto py-8 px-4 sm:px-6 lg:px-8">
      <div className="mb-8">
        <h1 className="text-4xl font-bold mb-2">{tHardcodedUi.raw('appHelpPage.line15JsxTextHelpCenter')}</h1>
        <p className="text-lg text-muted-foreground">
        </p>
      </div>

      <div className="space-y-8">
        <section>
          <h2 className="text-2xl font-semibold mb-4">{tHardcodedUi.raw('appHelpPage.line22JsxTextBillingUsage')}</h2>
          <p className="mb-6">{tHardcodedUi.raw('appHelpPage.line24JsxTextUnderstandHowCreditsWorkAndManageYourSubscription')}</p>

          <Link href="/help/credits-explained">
            <Card className="hover:bg-muted/50 transition-colors cursor-pointer">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-2xl bg-muted">
                    <Coins className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div>
                    <CardTitle>{tHardcodedUi.raw('appHelpPage.line35JsxTextWhatAreCredits')}</CardTitle>
                    <CardDescription>{tHardcodedUi.raw('appHelpPage.line37JsxTextLearnAboutCreditTypesHowTheyReConsumed')}</CardDescription>
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
