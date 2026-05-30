'use client';

import { Zap, Clock, Sparkles, Info, RotateCcw, Infinity, DollarSign } from 'lucide-react';
import {
  Card,
  CardContent,
  CardHeader,
} from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useTranslations } from 'next-intl';

export default function CreditsPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const t = useTranslations('billing.creditsExplainedPage');

  return (
    <div className="container mx-auto max-w-4xl px-3 sm:px-4 py-4 sm:py-8 md:py-12">
      {/* Header Section */}
      <div className="space-y-2 sm:space-y-3 mb-6 sm:mb-10">
        <h1 className="text-2xl sm:text-3xl md:text-4xl font-medium tracking-tight text-foreground">
          {t('title')}
        </h1>
        <p className="text-base sm:text-lg text-muted-foreground">
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
                    <span className="font-medium text-foreground">{tHardcodedUi.raw('componentsPagesCreditsExplainedPage.line56JsxTextAiActivity')}</span>{tHardcodedUi.raw('componentsPagesCreditsExplainedPage.line56JsxTextProcessingRequestsGeneratingResponsesMakingDecisionsAndRunning')}</div>
                </li>
                <li className="flex items-start gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                  <div>
                    <span className="font-medium text-foreground">{tHardcodedUi.raw('componentsPagesCreditsExplainedPage.line62JsxTextKortixComputer')}</span>{tHardcodedUi.raw('componentsPagesCreditsExplainedPage.line62JsxTextTheExecutionEnvironmentThatPowersCodeExecutionBrowser')}</div>
                </li>
                <li className="flex items-start gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                  <div>
                    <span className="font-medium text-foreground">{tHardcodedUi.raw('componentsPagesCreditsExplainedPage.line68JsxTextFileStorageAndManagement')}</span>{tHardcodedUi.raw('componentsPagesCreditsExplainedPage.line68JsxTextStoringOrganizingAndManagingFilesCreatedDuringYour')}</div>
                </li>
                <li className="flex items-start gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                  <div>
                    <span className="font-medium text-foreground">{tHardcodedUi.raw('componentsPagesCreditsExplainedPage.line74JsxTextWebSearch')}</span>{tHardcodedUi.raw('componentsPagesCreditsExplainedPage.line74JsxTextSearchingTheInternetForInformationDataAndResources')}</div>
                </li>
                <li className="flex items-start gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                  <div>
                    <span className="font-medium text-foreground">{tHardcodedUi.raw('componentsPagesCreditsExplainedPage.line80JsxTextPeopleSearch')}</span>{tHardcodedUi.raw('componentsPagesCreditsExplainedPage.line80JsxTextFindingAndRetrievingInformationAboutPeopleContactsAnd')}</div>
                </li>
                <li className="flex items-start gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                  <div>
                    <span className="font-medium text-foreground">{tHardcodedUi.raw('componentsPagesCreditsExplainedPage.line86JsxTextThirdPartyServices')}</span>{tHardcodedUi.raw('componentsPagesCreditsExplainedPage.line86JsxTextAccessingExternalApisDatabasesAndIntegratedServicesThat')}</div>
                </li>
              </ul>
              <div className="mt-6 pt-6 border-t border-border">
                <p className="text-muted-foreground leading-relaxed">{tHardcodedUi.raw('componentsPagesCreditsExplainedPage.line92JsxTextOnceATaskCompletesNoFurtherCreditsAre')}</p>
              </div>
              <Alert className="mt-4">
                <Info className="h-4 w-4" />
                <AlertDescription>{tHardcodedUi.raw('componentsPagesCreditsExplainedPage.line98JsxTextIfATaskFailsDueToASystem')}</AlertDescription>
              </Alert>
            </CardContent>
          </Card>
        </div>

        {/* Pricing Model */}
        <div className="space-y-6">
          <div className="flex items-center gap-2">
            <DollarSign className="h-5 w-5 text-primary" />
            <h2 className="text-xl font-semibold">{t('howCreditsWork.pricingModel.title')}</h2>
          </div>
          
          <p className="text-muted-foreground leading-relaxed">{tHardcodedUi.raw('componentsPagesCreditsExplainedPage.line113JsxTextWeApplyAMarkupOnTopOfProvider')}</p>

          <Card>
            <CardContent className="pt-6">
              <ul className="space-y-3 text-muted-foreground">
                <li className="flex items-start gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                  <div>
                    <span className="font-medium text-foreground">{tHardcodedUi.raw('componentsPagesCreditsExplainedPage.line122JsxTextAiModels20Markup')}</span>{tHardcodedUi.raw('componentsPagesCreditsExplainedPage.line122JsxTextAppliedToAllLlmApiCostsIncludingInput')}</div>
                </li>
                <li className="flex items-start gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                  <div>
                    <span className="font-medium text-foreground">{tHardcodedUi.raw('componentsPagesCreditsExplainedPage.line128JsxTextToolUsage50Markup')}</span>{tHardcodedUi.raw('componentsPagesCreditsExplainedPage.line128JsxTextAppliedToWebSearchWebScrapingAndOther')}</div>
                </li>
                <li className="flex items-start gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                  <div>
                    <span className="font-medium text-foreground">{tHardcodedUi.raw('componentsPagesCreditsExplainedPage.line134JsxTextImageSearch100Markup')}</span>{tHardcodedUi.raw('componentsPagesCreditsExplainedPage.line134JsxTextAppliedToImageSearchQueries')}</div>
                </li>
                <li className="flex items-start gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                  <div>
                    <span className="font-medium text-foreground">{tHardcodedUi.raw('componentsPagesCreditsExplainedPage.line140JsxTextBringYourOwnKey10PlatformFee')}</span>{tHardcodedUi.raw('componentsPagesCreditsExplainedPage.line140JsxTextIfYouUseYourOwnApiKeyA')}</div>
                </li>
              </ul>
            </CardContent>
          </Card>
        </div>

        {/* Types of Credits */}
        <div className="space-y-6">
          <div className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-primary" />
            <h2 className="text-xl font-semibold">{t('typesOfCredits.title')}</h2>
          </div>

          <p className="text-muted-foreground leading-relaxed">{tHardcodedUi.raw('componentsPagesCreditsExplainedPage.line156JsxTextCreditsAreUsedToPayForLlmCalls')}</p>

          {/* Credit Types Visual Grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Machine Bonus */}
            <Card className="border-blue-500/20 bg-gradient-to-br from-blue-500/5 to-transparent">
              <CardContent className="pt-5">
                <div className="flex items-center gap-2 mb-3">
                  <RotateCcw className="h-5 w-5 text-blue-500" />
                  <h3 className="font-semibold text-foreground">{tHardcodedUi.raw('componentsPagesCreditsExplainedPage.line166JsxTextMachineBonus')}</h3>
                </div>
                <p className="text-sm text-muted-foreground">{tHardcodedUi.raw('componentsPagesCreditsExplainedPage.line169JsxTextText500Credits5GrantedOneTimeWhenYou')}</p>
              </CardContent>
            </Card>

            {/* Purchased Credits */}
            <Card className="border-orange-500/20 bg-gradient-to-br from-orange-500/5 to-transparent">
              <CardContent className="pt-5">
                <div className="flex items-center gap-2 mb-3">
                  <Clock className="h-5 w-5 text-orange-500" />
                  <h3 className="font-semibold text-foreground">Purchased</h3>
                </div>
                <p className="text-sm text-muted-foreground">{tHardcodedUi.raw('componentsPagesCreditsExplainedPage.line182JsxTextBuyCreditPacks10500OrEnableAuto')}</p>
              </CardContent>
            </Card>

            {/* Legacy Monthly */}
            <Card className="border-border">
              <CardContent className="pt-5">
                <div className="flex items-center gap-2 mb-3">
                  <Infinity className="h-5 w-5 text-muted-foreground" />
                  <h3 className="font-semibold text-foreground">{tHardcodedUi.raw('componentsPagesCreditsExplainedPage.line192JsxTextMonthlyLegacy')}</h3>
                </div>
                <p className="text-sm text-muted-foreground">{tHardcodedUi.raw('componentsPagesCreditsExplainedPage.line195JsxTextSomeLegacyPlansIncludeMonthlyCreditsThatRefresh')}</p>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-4">
            <div>
              <h3 className="font-semibold text-foreground mb-3">{tHardcodedUi.raw('componentsPagesCreditsExplainedPage.line203JsxTextHowYouGetCredits')}</h3>
              <div className="space-y-3 text-muted-foreground">
                <div className="flex items-start gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-blue-500 mt-2 flex-shrink-0" />
                  <div>
                    <span className="font-medium text-foreground">{tHardcodedUi.raw('componentsPagesCreditsExplainedPage.line208JsxTextMachineBonus')}</span>{tHardcodedUi.raw('componentsPagesCreditsExplainedPage.line208JsxTextEveryNewCloudComputerComesWith500Credits')}</div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-orange-500 mt-2 flex-shrink-0" />
                  <div>
                    <span className="font-medium text-foreground">{tHardcodedUi.raw('componentsPagesCreditsExplainedPage.line214JsxTextCreditPurchases')}</span>{tHardcodedUi.raw('componentsPagesCreditsExplainedPage.line214JsxTextBuyPacksOfCreditsAnytimeAvailableIn10')}</div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                  <div>
                    <span className="font-medium text-foreground">Auto-topup:</span>{tHardcodedUi.raw('componentsPagesCreditsExplainedPage.line220JsxTextAutomaticallyRechargeWhenYourBalanceGetsLowEnabled')}</div>
                </div>
              </div>
            </div>
          </div>

          {/* Priority Order Info */}
          <Alert className="border-blue-500/20 bg-blue-500/5">
            <Info className="h-4 w-4" />
            <AlertDescription>
              <strong>{tHardcodedUi.raw('componentsPagesCreditsExplainedPage.line231JsxTextCreditUsage')}</strong>{tHardcodedUi.raw('componentsPagesCreditsExplainedPage.line231JsxTextCreditsAreDeductedPerLlmTokenUsedAnd')}</AlertDescription>
          </Alert>
        </div>

      </div>
    </div>
  );
}
