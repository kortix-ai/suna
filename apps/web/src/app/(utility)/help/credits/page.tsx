'use client';

import { useTranslations } from 'next-intl';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ArrowLeftIcon as ArrowLeft,
  ClockIcon as Clock,
  CoinsIcon as Coins,
  CurrencyDollarIcon as DollarSign,
  GiftIcon as Gift,
  InfinityIcon as Infinity,
  InfoIcon as Info,
  EnvelopeIcon as Mail,
  ChatCircleIcon as MessageCircle,
  ArrowClockwiseIcon as RefreshCw,
  LightningIcon as Zap,
} from '@phosphor-icons/react';
import Link from 'next/link';

export default function CreditsPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-8">
        <Link href="/help">
          <Button variant="ghost" className="mb-4">
            <ArrowLeft className="mr-2 h-4 w-4" />
            {tHardcodedUi.raw('appHelpCreditsPage.line29JsxTextBackToHelpCenter')}
          </Button>
        </Link>
        <h1 className="mb-2 text-4xl font-bold">
          {tHardcodedUi.raw('appHelpCreditsPage.line32JsxTextWhatAreCredits')}
        </h1>
        <p className="text-muted-foreground text-lg">
          {tHardcodedUi.raw('appHelpCreditsPage.line34JsxTextLearnHowCreditsWorkAndHowTheyRe')}
        </p>
      </div>

      <div className="space-y-8">
        <section>
          <h2 className="mb-4 text-2xl font-semibold">
            {tHardcodedUi.raw('appHelpCreditsPage.line40JsxTextWhatAreCredits')}
          </h2>
          <p className="mb-8 text-lg">
            {tHardcodedUi.raw(
              'appHelpCreditsPage.line42JsxTextCreditsAreKortixSStandardUnitOfMeasurement',
            )}
          </p>
        </section>

        <section>
          <h2 className="mb-4 text-2xl font-semibold">
            {tHardcodedUi.raw('appHelpCreditsPage.line47JsxTextTypesOfCredits')}
          </h2>
          <p className="mb-6">
            {tHardcodedUi.raw('appHelpCreditsPage.line49JsxTextKortixUsesTwoTypesOfCreditsToGive')}
          </p>

          <div className="mb-8 grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="bg-muted rounded-2xl p-2">
                    <Clock className="text-muted-foreground h-5 w-5" />
                  </div>
                  <div>
                    <CardTitle>
                      {tHardcodedUi.raw('appHelpCreditsPage.line60JsxTextExpiringCredits')}
                    </CardTitle>
                    <CardDescription>
                      {tHardcodedUi.raw(
                        'appHelpCreditsPage.line62JsxTextMonthlySubscriptionCredits',
                      )}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground text-sm">
                  {tHardcodedUi.raw(
                    'appHelpCreditsPage.line69JsxTextTheseCreditsAreIncludedWithYourPaidSubscription',
                  )}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="bg-muted rounded-2xl p-2">
                    <Infinity className="text-muted-foreground h-5 w-5" />
                  </div>
                  <div>
                    <CardTitle>
                      {tHardcodedUi.raw('appHelpCreditsPage.line83JsxTextNonExpiringCredits')}
                    </CardTitle>
                    <CardDescription>
                      {tHardcodedUi.raw(
                        'appHelpCreditsPage.line85JsxTextPermanentCreditsThatNeverExpire',
                      )}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground text-sm">
                  {tHardcodedUi.raw(
                    'appHelpCreditsPage.line92JsxTextTheseCreditsNeverExpireAndCarryOverMonth',
                  )}
                </p>
              </CardContent>
            </Card>
          </div>

          <Alert className="mb-8">
            <Info className="h-4 w-4" />
            <AlertDescription>
              <strong>{tHardcodedUi.raw('appHelpCreditsPage.line103JsxTextCreditPriority')}</strong>
              {tHardcodedUi.raw(
                'appHelpCreditsPage.line103JsxTextWhenYouUseKortixExpiringCreditsAreConsumed',
              )}
            </AlertDescription>
          </Alert>
        </section>

        <section>
          <h2 className="mb-4 text-2xl font-semibold">
            {tHardcodedUi.raw('appHelpCreditsPage.line110JsxTextHowCreditsWork')}
          </h2>
          <p className="mb-6">
            {tHardcodedUi.raw(
              'appHelpCreditsPage.line112JsxTextCreditsAreConsumedBasedOnTheResourcesYour',
            )}
          </p>

          <div className="mb-8 space-y-4">
            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="bg-muted rounded-2xl p-2">
                    <Zap className="text-muted-foreground h-5 w-5" />
                  </div>
                  <div>
                    <CardTitle>
                      {tHardcodedUi.raw('appHelpCreditsPage.line123JsxTextAiModelUsage')}
                    </CardTitle>
                    <CardDescription>
                      {tHardcodedUi.raw(
                        'appHelpCreditsPage.line125JsxTextThePrimaryDriverOfCreditConsumption',
                      )}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground text-sm">
                  {tHardcodedUi.raw(
                    'appHelpCreditsPage.line132JsxTextDifferentAiModelsHaveDifferentCostsBasedOn',
                  )}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="bg-muted rounded-2xl p-2">
                    <DollarSign className="text-muted-foreground h-5 w-5" />
                  </div>
                  <div>
                    <CardTitle>
                      {tHardcodedUi.raw('appHelpCreditsPage.line146JsxTextPricingModel')}
                    </CardTitle>
                    <CardDescription>
                      {tHardcodedUi.raw(
                        'appHelpCreditsPage.line148JsxTextPlatformRatesVaryByServiceType',
                      )}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <p className="text-muted-foreground text-sm">
                    {tHardcodedUi.raw(
                      'appHelpCreditsPage.line156JsxTextWeApplyAMarkupOnTopOfProvider',
                    )}
                  </p>
                  <ul className="text-muted-foreground space-y-2 text-sm">
                    <li className="flex items-start gap-2">
                      <span className="bg-primary mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" />
                      <span>
                        <strong className="text-foreground">
                          {tHardcodedUi.raw('appHelpCreditsPage.line162JsxTextAiModels')}
                        </strong>
                        {tHardcodedUi.raw(
                          'appHelpCreditsPage.line162JsxTextText20MarkupOnAllLlmApiCostsInput',
                        )}
                      </span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="bg-primary mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" />
                      <span>
                        <strong className="text-foreground">
                          {tHardcodedUi.raw('appHelpCreditsPage.line166JsxTextToolUsage')}
                        </strong>
                        {tHardcodedUi.raw(
                          'appHelpCreditsPage.line166JsxTextText50MarkupOnWebSearchWebScrapingAnd',
                        )}
                      </span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="bg-primary mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" />
                      <span>
                        <strong className="text-foreground">
                          {tHardcodedUi.raw('appHelpCreditsPage.line170JsxTextImageSearch')}
                        </strong>
                        {tHardcodedUi.raw(
                          'appHelpCreditsPage.line170JsxTextText100MarkupOnImageSearchQueries',
                        )}
                      </span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="bg-primary mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" />
                      <span>
                        <strong className="text-foreground">
                          {tHardcodedUi.raw('appHelpCreditsPage.line174JsxTextBringYourOwnKey')}
                        </strong>
                        {tHardcodedUi.raw(
                          'appHelpCreditsPage.line174JsxTextIfYouUseYourOwnApiKeyA',
                        )}
                      </span>
                    </li>
                  </ul>
                </div>
              </CardContent>
            </Card>
          </div>
        </section>

        <section>
          <h2 className="mb-4 text-2xl font-semibold">
            {tHardcodedUi.raw('appHelpCreditsPage.line184JsxTextGettingMoreCredits')}
          </h2>
          <p className="mb-6">
            {tHardcodedUi.raw(
              'appHelpCreditsPage.line186JsxTextThereAreSeveralWaysToObtainCreditsIn',
            )}
          </p>

          <div className="mb-8 space-y-4">
            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="bg-muted rounded-2xl p-2">
                    <RefreshCw className="text-muted-foreground h-5 w-5" />
                  </div>
                  <div>
                    <CardTitle>
                      {tHardcodedUi.raw(
                        'appHelpCreditsPage.line197JsxTextMonthlySubscriptionCredits',
                      )}
                    </CardTitle>
                    <CardDescription>
                      {tHardcodedUi.raw(
                        'appHelpCreditsPage.line199JsxTextIncludedWithYourPaidPlanAndRenewedAutomatically',
                      )}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="bg-muted rounded-2xl p-2">
                    <Coins className="text-muted-foreground h-5 w-5" />
                  </div>
                  <div>
                    <CardTitle>
                      {tHardcodedUi.raw('appHelpCreditsPage.line213JsxTextTopUpCredits')}
                    </CardTitle>
                    <CardDescription>
                      {tHardcodedUi.raw(
                        'appHelpCreditsPage.line215JsxTextPurchaseAdditionalCreditsWhenYouNeedThemThese',
                      )}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="bg-muted rounded-2xl p-2">
                    <Gift className="text-muted-foreground h-5 w-5" />
                  </div>
                  <div>
                    <CardTitle>
                      {tHardcodedUi.raw('appHelpCreditsPage.line229JsxTextPromotionalEventGrants')}
                    </CardTitle>
                    <CardDescription>
                      {tHardcodedUi.raw(
                        'appHelpCreditsPage.line231JsxTextBonusCreditsFromSpecialEventsPromotionsOrReferrals',
                      )}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="bg-muted rounded-2xl p-2">
                    <RefreshCw className="text-muted-foreground h-5 w-5" />
                  </div>
                  <div>
                    <CardTitle>Refunds</CardTitle>
                    <CardDescription>
                      {tHardcodedUi.raw(
                        'appHelpCreditsPage.line247JsxTextCreditsReturnedDueToTechnicalIssuesOrFailed',
                      )}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
            </Card>
          </div>
        </section>

        <section>
          <h2 className="mb-4 text-2xl font-semibold">
            {tHardcodedUi.raw('appHelpCreditsPage.line257JsxTextTrackingYourUsage')}
          </h2>
          <p className="mb-6">
            {tHardcodedUi.raw(
              'appHelpCreditsPage.line259JsxTextMonitorYourCreditConsumptionThroughTheSettingsPanel',
            )}
          </p>

          <div className="mb-8 space-y-3">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {tHardcodedUi.raw('appHelpCreditsPage.line265JsxTextSettingsBilling')}
                </CardTitle>
                <CardDescription>
                  {tHardcodedUi.raw(
                    'appHelpCreditsPage.line267JsxTextViewYourCurrentCreditBalanceAndBreakdownBetween',
                  )}
                </CardDescription>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {tHardcodedUi.raw('appHelpCreditsPage.line273JsxTextSettingsUsage')}
                </CardTitle>
                <CardDescription>
                  {tHardcodedUi.raw(
                    'appHelpCreditsPage.line275JsxTextTrackCreditConsumptionByThreadAndConversationTo',
                  )}
                </CardDescription>
              </CardHeader>
            </Card>
          </div>
        </section>

        <section>
          <h2 className="mb-4 text-2xl font-semibold">
            {tHardcodedUi.raw('appHelpCreditsPage.line283JsxTextOptimizingCreditUsage')}
          </h2>
          <p className="mb-6">
            {tHardcodedUi.raw(
              'appHelpCreditsPage.line285JsxTextMakeYourCreditsGoFurtherWithTheseOptimization',
            )}
          </p>

          <div className="mb-8 space-y-3">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {tHardcodedUi.raw('appHelpCreditsPage.line291JsxTextChooseAppropriateModels')}
                </CardTitle>
                <CardDescription>
                  {tHardcodedUi.raw(
                    'appHelpCreditsPage.line293JsxTextUseSmallerMoreEfficientModelsForSimplerTasks',
                  )}
                </CardDescription>
              </CardHeader>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {tHardcodedUi.raw('appHelpCreditsPage.line300JsxTextProvideClearInstructions')}
                </CardTitle>
                <CardDescription>
                  {tHardcodedUi.raw(
                    'appHelpCreditsPage.line302JsxTextWellDefinedTasksReduceBackAndForthWith',
                  )}
                </CardDescription>
              </CardHeader>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {tHardcodedUi.raw('appHelpCreditsPage.line309JsxTextMonitorYourUsage')}
                </CardTitle>
                <CardDescription>
                  {tHardcodedUi.raw(
                    'appHelpCreditsPage.line311JsxTextRegularlyCheckTheUsageTabToIdentifyWhich',
                  )}
                </CardDescription>
              </CardHeader>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {tHardcodedUi.raw('appHelpCreditsPage.line318JsxTextLeveragePromptCaching')}
                </CardTitle>
                <CardDescription>
                  {tHardcodedUi.raw(
                    'appHelpCreditsPage.line320JsxTextRepeatedConversationsInTheSameThreadBenefitFrom',
                  )}
                </CardDescription>
              </CardHeader>
            </Card>
          </div>
        </section>

        <section>
          <h2 className="mb-4 text-2xl font-semibold">
            {tHardcodedUi.raw('appHelpCreditsPage.line328JsxTextNeedHelp')}
          </h2>
          <p className="mb-6">
            {tHardcodedUi.raw(
              'appHelpCreditsPage.line330JsxTextIfYouNoticeAnyDiscrepanciesInYourCredit',
            )}
          </p>

          <div className="mb-8 flex flex-col gap-3 sm:flex-row">
            <Button
              variant="outline"
              className="gap-2"
              onClick={() => (window.location.href = 'mailto:hey@kortix.com')}
            >
              <Mail className="h-4 w-4" />
              {tHardcodedUi.raw('appHelpCreditsPage.line340JsxTextEmailSupport')}
            </Button>
            <Button
              variant="outline"
              className="gap-2"
              onClick={() =>
                window.open(
                  'https://discord.com/invite/RvFhXUdZ9H',
                  '_blank',
                  'noopener,noreferrer',
                )
              }
            >
              <MessageCircle className="h-4 w-4" />
              {tHardcodedUi.raw('appHelpCreditsPage.line348JsxTextJoinDiscord')}
            </Button>
          </div>

          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription>
              {tHardcodedUi.raw(
                'appHelpCreditsPage.line355JsxTextWeReCommittedToFairAndTransparentBilling',
              )}
            </AlertDescription>
          </Alert>
        </section>
      </div>
    </div>
  );
}
