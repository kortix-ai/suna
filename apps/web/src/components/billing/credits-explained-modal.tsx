'use client';

import { useTranslations } from 'next-intl';

import { Zap, Clock, Sparkles, Info, RotateCcw, Infinity, X, DollarSign } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Card,
  CardContent,
} from '@/components/ui/card';
import { InfoBanner } from '@/components/ui/info-banner';

interface CreditsExplainedModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreditsExplainedModal({ open, onOpenChange }: CreditsExplainedModalProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-2xl max-h-[85vh]">
        <DialogHeader className="border-b border-border/60 px-6 pt-6 pb-4">
          <DialogTitle className="text-lg font-semibold tracking-tight">{tHardcodedUi.raw('componentsBillingCreditsExplainedModal.line26JsxTextWhatAreCredits')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-8 overflow-y-auto px-6 py-5">
          {/* Introduction */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold">{tHardcodedUi.raw('componentsBillingCreditsExplainedModal.line34JsxTextUnderstandingCredits')}</h2>
            </div>
            <p className="text-muted-foreground leading-relaxed">{tHardcodedUi.raw('componentsBillingCreditsExplainedModal.line37JsxTextCreditsAreTheUniversalCurrencyThatPowersEverything')}</p>
          </div>

          {/* How Credits Work */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Zap className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold">{tHardcodedUi.raw('componentsBillingCreditsExplainedModal.line47JsxTextHowCreditsWork')}</h2>
            </div>
            
            <p className="text-muted-foreground leading-relaxed">{tHardcodedUi.raw('componentsBillingCreditsExplainedModal.line51JsxTextCreditsAreConsumedBasedOnTheResourcesYour')}</p>

            <Card>
              <CardContent className="pt-5">
                <ul className="space-y-2.5 text-sm text-muted-foreground">
                  <li className="flex items-start gap-3">
                    <div className="w-1.5 h-1.5 rounded-full bg-primary mt-1.5 flex-shrink-0" />
                    <div>
                      <span className="font-medium text-foreground">{tHardcodedUi.raw('componentsBillingCreditsExplainedModal.line60JsxTextAiActivity')}</span>{tHardcodedUi.raw('componentsBillingCreditsExplainedModal.line60JsxTextProcessingRequestsGeneratingResponsesAndRunningAiModels')}</div>
                  </li>
                  <li className="flex items-start gap-3">
                    <div className="w-1.5 h-1.5 rounded-full bg-primary mt-1.5 flex-shrink-0" />
                    <div>
                      <span className="font-medium text-foreground">{tHardcodedUi.raw('componentsBillingCreditsExplainedModal.line66JsxTextKortixComputer')}</span>{tHardcodedUi.raw('componentsBillingCreditsExplainedModal.line66JsxTextCodeExecutionBrowserAutomationAndInteractiveTaskProcessing')}</div>
                  </li>
                  <li className="flex items-start gap-3">
                    <div className="w-1.5 h-1.5 rounded-full bg-primary mt-1.5 flex-shrink-0" />
                    <div>
                      <span className="font-medium text-foreground">{tHardcodedUi.raw('componentsBillingCreditsExplainedModal.line72JsxTextWebPeopleSearch')}</span>{tHardcodedUi.raw('componentsBillingCreditsExplainedModal.line72JsxTextFindingInformationDataAndResourcesOnline')}</div>
                  </li>
                  <li className="flex items-start gap-3">
                    <div className="w-1.5 h-1.5 rounded-full bg-primary mt-1.5 flex-shrink-0" />
                    <div>
                      <span className="font-medium text-foreground">{tHardcodedUi.raw('componentsBillingCreditsExplainedModal.line78JsxTextThirdPartyServices')}</span>{tHardcodedUi.raw('componentsBillingCreditsExplainedModal.line78JsxTextExternalApisAndIntegratedServices')}</div>
                  </li>
                </ul>
              </CardContent>
            </Card>
          </div>

          {/* Pricing Model */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <DollarSign className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold">Pricing</h2>
            </div>

            <p className="text-muted-foreground leading-relaxed text-sm">{tHardcodedUi.raw('componentsBillingCreditsExplainedModal.line94JsxTextPlatformRatesVaryByServiceType')}</p>

            <Card>
              <CardContent className="pt-5">
                <ul className="space-y-2.5 text-sm text-muted-foreground">
                  <li className="flex items-start gap-3">
                    <div className="w-1.5 h-1.5 rounded-full bg-primary mt-1.5 flex-shrink-0" />
                    <div>
                      <span className="font-medium text-foreground">{tHardcodedUi.raw('componentsBillingCreditsExplainedModal.line103JsxTextAiModels')}</span>{tHardcodedUi.raw('componentsBillingCreditsExplainedModal.line103JsxTextText20MarkupOnLlmCosts')}</div>
                  </li>
                  <li className="flex items-start gap-3">
                    <div className="w-1.5 h-1.5 rounded-full bg-primary mt-1.5 flex-shrink-0" />
                    <div>
                      <span className="font-medium text-foreground">Tools:</span>{tHardcodedUi.raw('componentsBillingCreditsExplainedModal.line109JsxTextText50MarkupOnWebSearchScrapingAndThird')}</div>
                  </li>
                  <li className="flex items-start gap-3">
                    <div className="w-1.5 h-1.5 rounded-full bg-primary mt-1.5 flex-shrink-0" />
                    <div>
                      <span className="font-medium text-foreground">{tHardcodedUi.raw('componentsBillingCreditsExplainedModal.line115JsxTextImageSearch')}</span>{tHardcodedUi.raw('componentsBillingCreditsExplainedModal.line115JsxTextText100Markup')}</div>
                  </li>
                  <li className="flex items-start gap-3">
                    <div className="w-1.5 h-1.5 rounded-full bg-primary mt-1.5 flex-shrink-0" />
                    <div>
                      <span className="font-medium text-foreground">{tHardcodedUi.raw('componentsBillingCreditsExplainedModal.line121JsxTextOwnApiKey')}</span>{tHardcodedUi.raw('componentsBillingCreditsExplainedModal.line121JsxTextText10PlatformFeeInstead')}</div>
                  </li>
                </ul>
              </CardContent>
            </Card>
          </div>

          {/* Types of Credits */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Clock className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold">{tHardcodedUi.raw('componentsBillingCreditsExplainedModal.line133JsxTextTypesOfCredits')}</h2>
            </div>

            <p className="text-muted-foreground leading-relaxed text-sm">{tHardcodedUi.raw('componentsBillingCreditsExplainedModal.line137JsxTextCreditsAreDeductedInPriorityOrderDailyCredits')}</p>

            {/* Credit Types Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {/* Daily Credits */}
              <Card>
                <CardContent className="pt-4 pb-4">
                  <div className="flex items-center gap-2 mb-2">
                    <RotateCcw className="h-4 w-4 text-muted-foreground" />
                    <h3 className="font-semibold text-sm">Daily</h3>
                  </div>
                  <p className="text-xs text-muted-foreground">{tHardcodedUi.raw('componentsBillingCreditsExplainedModal.line150JsxTextRefreshEvery24HoursUseItOrLose')}</p>
                </CardContent>
              </Card>

              {/* Monthly Credits */}
              <Card>
                <CardContent className="pt-4 pb-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Clock className="h-4 w-4 text-muted-foreground" />
                    <h3 className="font-semibold text-sm">Monthly</h3>
                  </div>
                  <p className="text-xs text-muted-foreground">{tHardcodedUi.raw('componentsBillingCreditsExplainedModal.line163JsxTextIncludedWithYourPlanRefreshEachBillingCycle')}</p>
                </CardContent>
              </Card>

              {/* Extra Credits */}
              <Card>
                <CardContent className="pt-4 pb-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Infinity className="h-4 w-4 text-muted-foreground" />
                    <h3 className="font-semibold text-sm">Extra</h3>
                  </div>
                  <p className="text-xs text-muted-foreground">{tHardcodedUi.raw('componentsBillingCreditsExplainedModal.line176JsxTextPurchasedOrPromoCreditsThatNeverExpire')}</p>
                </CardContent>
              </Card>
            </div>
          </div>

          {/* Priority Order Info */}
          <InfoBanner tone="info" icon={Info}>
            <strong>{tHardcodedUi.raw('componentsBillingCreditsExplainedModal.line185JsxTextCreditPriority')}</strong>{tHardcodedUi.raw('componentsBillingCreditsExplainedModal.line185JsxTextWeUseExpiringCreditsFirstDailyMonthlyBefore')}</InfoBanner>

          {/* Refund Policy */}
          <InfoBanner tone="neutral" icon={Info}>{tHardcodedUi.raw('componentsBillingCreditsExplainedModal.line191JsxTextIfATaskFailsDueToASystem')}</InfoBanner>
        </div>
      </DialogContent>
    </Dialog>
  );
}
