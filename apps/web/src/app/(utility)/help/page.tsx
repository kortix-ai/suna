'use client';

import { useTranslations } from 'next-intl';

import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CoinsIcon as Coins } from '@phosphor-icons/react';
import Link from 'next/link';

export default function HelpCenterPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-8">
        <h1 className="mb-2 text-4xl font-bold">
          {tHardcodedUi.raw('appHelpPage.line15JsxTextHelpCenter')}
        </h1>
        <p className="text-muted-foreground text-lg"></p>
      </div>

      <div className="space-y-8">
        <section>
          <h2 className="mb-4 text-2xl font-semibold">
            {tHardcodedUi.raw('appHelpPage.line22JsxTextBillingUsage')}
          </h2>
          <p className="mb-6">
            {tHardcodedUi.raw(
              'appHelpPage.line24JsxTextUnderstandHowCreditsWorkAndManageYourSubscription',
            )}
          </p>

          <Link href="/help/credits-explained">
            <Card className="hover:bg-muted/50 cursor-pointer transition-colors">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="bg-muted rounded-2xl p-2">
                    <Coins className="text-muted-foreground h-5 w-5" />
                  </div>
                  <div>
                    <CardTitle>
                      {tHardcodedUi.raw('appHelpPage.line35JsxTextWhatAreCredits')}
                    </CardTitle>
                    <CardDescription>
                      {tHardcodedUi.raw(
                        'appHelpPage.line37JsxTextLearnAboutCreditTypesHowTheyReConsumed',
                      )}
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
