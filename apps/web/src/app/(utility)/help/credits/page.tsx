'use client';

import { useTranslations } from 'next-intl';

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
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="max-w-4xl mx-auto py-8 px-4 sm:px-6 lg:px-8">
      <div className="mb-8">
        <Link href="/help">
          <Button variant="ghost" className="mb-4">
            <ArrowLeft className="h-4 w-4 mr-2" />{tHardcodedUi.raw('appHelpCreditsPage.line29JsxTextBackToHelpCenter')}</Button>
        </Link>
        <h1 className="text-4xl font-bold mb-2">{tHardcodedUi.raw('appHelpCreditsPage.line32JsxTextWhatAreCredits')}</h1>
        <p className="text-lg text-muted-foreground">{tHardcodedUi.raw('appHelpCreditsPage.line34JsxTextLearnHowCreditsWorkAndHowTheyRe')}</p>
      </div>

      <div className="space-y-8">
        <section>
          <h2 className="text-2xl font-semibold mb-4">{tHardcodedUi.raw('appHelpCreditsPage.line40JsxTextWhatAreCredits')}</h2>
          <p className="text-lg mb-8">{tHardcodedUi.raw('appHelpCreditsPage.line42JsxTextCreditsAreKortixSStandardUnitOfMeasurement')}</p>
        </section>

        <section>
          <h2 className="text-2xl font-semibold mb-4">{tHardcodedUi.raw('appHelpCreditsPage.line47JsxTextTypesOfCredits')}</h2>
          <p className="mb-6">{tHardcodedUi.raw('appHelpCreditsPage.line49JsxTextKortixUsesTwoTypesOfCreditsToGive')}</p>

          <div className="grid gap-4 md:grid-cols-2 mb-8">
            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-2xl bg-muted">
                    <Clock className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div>
                    <CardTitle>{tHardcodedUi.raw('appHelpCreditsPage.line60JsxTextExpiringCredits')}</CardTitle>
                    <CardDescription>{tHardcodedUi.raw('appHelpCreditsPage.line62JsxTextMonthlySubscriptionCredits')}</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{tHardcodedUi.raw('appHelpCreditsPage.line69JsxTextTheseCreditsAreIncludedWithYourPaidSubscription')}</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-2xl bg-muted">
                    <Infinity className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div>
                    <CardTitle>{tHardcodedUi.raw('appHelpCreditsPage.line83JsxTextNonExpiringCredits')}</CardTitle>
                    <CardDescription>{tHardcodedUi.raw('appHelpCreditsPage.line85JsxTextPermanentCreditsThatNeverExpire')}</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{tHardcodedUi.raw('appHelpCreditsPage.line92JsxTextTheseCreditsNeverExpireAndCarryOverMonth')}</p>
              </CardContent>
            </Card>
          </div>

          <Alert className="mb-8">
            <Info className="h-4 w-4" />
            <AlertDescription>
              <strong>{tHardcodedUi.raw('appHelpCreditsPage.line103JsxTextCreditPriority')}</strong>{tHardcodedUi.raw('appHelpCreditsPage.line103JsxTextWhenYouUseKortixExpiringCreditsAreConsumed')}</AlertDescription>
          </Alert>
        </section>

        <section>
          <h2 className="text-2xl font-semibold mb-4">{tHardcodedUi.raw('appHelpCreditsPage.line110JsxTextHowCreditsWork')}</h2>
          <p className="mb-6">{tHardcodedUi.raw('appHelpCreditsPage.line112JsxTextCreditsAreConsumedBasedOnTheResourcesYour')}</p>

          <div className="space-y-4 mb-8">
            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-2xl bg-muted">
                    <Zap className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div>
                    <CardTitle>{tHardcodedUi.raw('appHelpCreditsPage.line123JsxTextAiModelUsage')}</CardTitle>
                    <CardDescription>{tHardcodedUi.raw('appHelpCreditsPage.line125JsxTextThePrimaryDriverOfCreditConsumption')}</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{tHardcodedUi.raw('appHelpCreditsPage.line132JsxTextDifferentAiModelsHaveDifferentCostsBasedOn')}</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-2xl bg-muted">
                    <DollarSign className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div>
                    <CardTitle>{tHardcodedUi.raw('appHelpCreditsPage.line146JsxTextPricingModel')}</CardTitle>
                    <CardDescription>{tHardcodedUi.raw('appHelpCreditsPage.line148JsxTextPlatformRatesVaryByServiceType')}</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">{tHardcodedUi.raw('appHelpCreditsPage.line156JsxTextWeApplyAMarkupOnTopOfProvider')}</p>
                  <ul className="space-y-2 text-sm text-muted-foreground">
                    <li className="flex items-start gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-primary mt-1.5 flex-shrink-0" />
                      <span><strong className="text-foreground">{tHardcodedUi.raw('appHelpCreditsPage.line162JsxTextAiModels')}</strong>{tHardcodedUi.raw('appHelpCreditsPage.line162JsxTextText20MarkupOnAllLlmApiCostsInput')}</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-primary mt-1.5 flex-shrink-0" />
                      <span><strong className="text-foreground">{tHardcodedUi.raw('appHelpCreditsPage.line166JsxTextToolUsage')}</strong>{tHardcodedUi.raw('appHelpCreditsPage.line166JsxTextText50MarkupOnWebSearchWebScrapingAnd')}</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-primary mt-1.5 flex-shrink-0" />
                      <span><strong className="text-foreground">{tHardcodedUi.raw('appHelpCreditsPage.line170JsxTextImageSearch')}</strong>{tHardcodedUi.raw('appHelpCreditsPage.line170JsxTextText100MarkupOnImageSearchQueries')}</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-primary mt-1.5 flex-shrink-0" />
                      <span><strong className="text-foreground">{tHardcodedUi.raw('appHelpCreditsPage.line174JsxTextBringYourOwnKey')}</strong>{tHardcodedUi.raw('appHelpCreditsPage.line174JsxTextIfYouUseYourOwnApiKeyA')}</span>
                    </li>
                  </ul>
                </div>
              </CardContent>
            </Card>
          </div>
        </section>

        <section>
          <h2 className="text-2xl font-semibold mb-4">{tHardcodedUi.raw('appHelpCreditsPage.line184JsxTextGettingMoreCredits')}</h2>
          <p className="mb-6">{tHardcodedUi.raw('appHelpCreditsPage.line186JsxTextThereAreSeveralWaysToObtainCreditsIn')}</p>

          <div className="space-y-4 mb-8">
            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-2xl bg-muted">
                    <RefreshCw className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div>
                    <CardTitle>{tHardcodedUi.raw('appHelpCreditsPage.line197JsxTextMonthlySubscriptionCredits')}</CardTitle>
                    <CardDescription>{tHardcodedUi.raw('appHelpCreditsPage.line199JsxTextIncludedWithYourPaidPlanAndRenewedAutomatically')}</CardDescription>
                  </div>
                </div>
              </CardHeader>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-2xl bg-muted">
                    <Coins className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div>
                    <CardTitle>{tHardcodedUi.raw('appHelpCreditsPage.line213JsxTextTopUpCredits')}</CardTitle>
                    <CardDescription>{tHardcodedUi.raw('appHelpCreditsPage.line215JsxTextPurchaseAdditionalCreditsWhenYouNeedThemThese')}</CardDescription>
                  </div>
                </div>
              </CardHeader>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-2xl bg-muted">
                    <Gift className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div>
                    <CardTitle>{tHardcodedUi.raw('appHelpCreditsPage.line229JsxTextPromotionalEventGrants')}</CardTitle>
                    <CardDescription>{tHardcodedUi.raw('appHelpCreditsPage.line231JsxTextBonusCreditsFromSpecialEventsPromotionsOrReferrals')}</CardDescription>
                  </div>
                </div>
              </CardHeader>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-2xl bg-muted">
                    <RefreshCw className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div>
                    <CardTitle>Refunds</CardTitle>
                    <CardDescription>{tHardcodedUi.raw('appHelpCreditsPage.line247JsxTextCreditsReturnedDueToTechnicalIssuesOrFailed')}</CardDescription>
                  </div>
                </div>
              </CardHeader>
            </Card>
          </div>
        </section>

        <section>
          <h2 className="text-2xl font-semibold mb-4">{tHardcodedUi.raw('appHelpCreditsPage.line257JsxTextTrackingYourUsage')}</h2>
          <p className="mb-6">{tHardcodedUi.raw('appHelpCreditsPage.line259JsxTextMonitorYourCreditConsumptionThroughTheSettingsPanel')}</p>

          <div className="space-y-3 mb-8">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{tHardcodedUi.raw('appHelpCreditsPage.line265JsxTextSettingsBilling')}</CardTitle>
                <CardDescription>{tHardcodedUi.raw('appHelpCreditsPage.line267JsxTextViewYourCurrentCreditBalanceAndBreakdownBetween')}</CardDescription>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{tHardcodedUi.raw('appHelpCreditsPage.line273JsxTextSettingsUsage')}</CardTitle>
                <CardDescription>{tHardcodedUi.raw('appHelpCreditsPage.line275JsxTextTrackCreditConsumptionByThreadAndConversationTo')}</CardDescription>
              </CardHeader>
            </Card>
          </div>
        </section>

        <section>
          <h2 className="text-2xl font-semibold mb-4">{tHardcodedUi.raw('appHelpCreditsPage.line283JsxTextOptimizingCreditUsage')}</h2>
          <p className="mb-6">{tHardcodedUi.raw('appHelpCreditsPage.line285JsxTextMakeYourCreditsGoFurtherWithTheseOptimization')}</p>

          <div className="space-y-3 mb-8">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{tHardcodedUi.raw('appHelpCreditsPage.line291JsxTextChooseAppropriateModels')}</CardTitle>
                <CardDescription>{tHardcodedUi.raw('appHelpCreditsPage.line293JsxTextUseSmallerMoreEfficientModelsForSimplerTasks')}</CardDescription>
              </CardHeader>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">{tHardcodedUi.raw('appHelpCreditsPage.line300JsxTextProvideClearInstructions')}</CardTitle>
                <CardDescription>{tHardcodedUi.raw('appHelpCreditsPage.line302JsxTextWellDefinedTasksReduceBackAndForthWith')}</CardDescription>
              </CardHeader>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">{tHardcodedUi.raw('appHelpCreditsPage.line309JsxTextMonitorYourUsage')}</CardTitle>
                <CardDescription>{tHardcodedUi.raw('appHelpCreditsPage.line311JsxTextRegularlyCheckTheUsageTabToIdentifyWhich')}</CardDescription>
              </CardHeader>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">{tHardcodedUi.raw('appHelpCreditsPage.line318JsxTextLeveragePromptCaching')}</CardTitle>
                <CardDescription>{tHardcodedUi.raw('appHelpCreditsPage.line320JsxTextRepeatedConversationsInTheSameThreadBenefitFrom')}</CardDescription>
              </CardHeader>
            </Card>
          </div>
        </section>

        <section>
          <h2 className="text-2xl font-semibold mb-4">{tHardcodedUi.raw('appHelpCreditsPage.line328JsxTextNeedHelp')}</h2>
          <p className="mb-6">{tHardcodedUi.raw('appHelpCreditsPage.line330JsxTextIfYouNoticeAnyDiscrepanciesInYourCredit')}</p>

          <div className="flex flex-col sm:flex-row gap-3 mb-8">
            <Button
              variant="outline"
              className="gap-2"
              onClick={() => window.location.href = 'mailto:hey@kortix.com'}
            >
              <Mail className="h-4 w-4" />{tHardcodedUi.raw('appHelpCreditsPage.line340JsxTextEmailSupport')}</Button>
            <Button
              variant="outline"
              className="gap-2"
              onClick={() => window.open('https://discord.com/invite/RvFhXUdZ9H', '_blank', 'noopener,noreferrer')}
            >
              <MessageCircle className="h-4 w-4" />{tHardcodedUi.raw('appHelpCreditsPage.line348JsxTextJoinDiscord')}</Button>
          </div>

          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription>{tHardcodedUi.raw('appHelpCreditsPage.line355JsxTextWeReCommittedToFairAndTransparentBilling')}</AlertDescription>
          </Alert>
        </section>
      </div>
    </div>
  );
}
